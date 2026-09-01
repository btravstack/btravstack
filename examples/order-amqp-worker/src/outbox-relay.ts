import { TypedAmqpClient } from "@amqp-contract/client";
import { AmqpConfig } from "@btravstack/amqp-worker";
import { Config } from "@btravstack/config";
import { Logger, Meter } from "@btravstack/core";
import { Port, Provider, type ServiceOf } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Outbox } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { ErrAsync, P, TaggedError, fromSafePromise, type AsyncResult } from "unthrown";

/**
 * What only the relay knows, as a service: its idle sleep and the tenants it
 * serves. `Config.provider(name)(schema)` mints the port, since the slice is
 * this deployment's own.
 *
 * `OUTBOX_TENANTS` has no default, because there is no safe one: the relay runs
 * outside any unit, so it cannot read a tenant off the ambient record, and
 * "whatever is in the table" is how one deployment starts broadcasting
 * another's facts. Naming them is also how a relay is sharded.
 */
export const relayConfig = Config.provider("RelayConfig")(
  Config.object({
    pollMs: Config.integer("OUTBOX_POLL_MS", { min: 1, max: 60_000, default: 200 }),
    tenants: Config.string("OUTBOX_TENANTS"),
  }),
);

/**
 * `"acme, globex"` → `["acme", "globex"]`; blank entries dropped, so a trailing
 * comma is not a tenant named `""`.
 *
 * The one place this deployment claims the `TenantId` brand: the relay's
 * tenants come from configuration rather than from a contract, so this parse
 * IS the boundary, and every sweep below carries the brand from here without
 * casting again.
 */
const tenantsOf = (value: string): readonly TenantId[] =>
  value
    .split(",")
    .map((tenant) => tenant.trim())
    .filter((tenant) => tenant !== "")
    .map(TenantId);

/** The running relay: nothing resolves it, and nothing needs to — it exists to be started and stopped. */
export class OutboxRelay extends Port("OutboxRelay")<{
  readonly stop: () => AsyncResult<void, never>;
}> {}

/** How many outbox rows one sweep publishes before sleeping. */
const BATCH = 32;

/**
 * The broker at `AMQP_URL` did not answer when the relay opened its client.
 * Modeled rather than left the defect `TypedAmqpClient.create` reports it as, so
 * `runMain` exits `1` — an operator can act on it, and neither a wrong URL nor a
 * broker that is down is a bug in this code.
 */
export class BrokerUnreachable extends TaggedError("BrokerUnreachable")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

/**
 * The other half of the outbox pattern: `OrderRepository.save` wrote the fact
 * down, this loop says it out loud — pull what is pending, publish it, mark it
 * sent, in commit order, until told to stop.
 *
 * Deliberately at-least-once. A crash between publish and `markPublished`
 * re-publishes on the next sweep; a broker outage leaves rows pending. What is
 * NEVER possible is an order committed whose event evaporated, because the event
 * was committed by the same transaction as the order.
 *
 * The client is created here rather than injected: a transport connection is the
 * transport's own, and it is not a second one — the connection manager pools by
 * URL, so this shares the consumer's worker's TCP connection and `close()`
 * releases a lease rather than the socket.
 */
const startOutboxRelay = (
  outbox: ServiceOf<Outbox>,
  logger: ServiceOf<Logger>,
  meter: ServiceOf<Meter>,
  {
    url,
    pollMs,
    tenants,
  }: { readonly url: string; readonly pollMs: number; readonly tenants: readonly TenantId[] },
): AsyncResult<ServiceOf<OutboxRelay>, BrokerUnreachable> =>
  TypedAmqpClient.create({ contract: orderContract, urls: [url] })
    .recoverDefect((cause) => ErrAsync(new BrokerUnreachable({ url, cause })))
    .map((client) => {
      // The relay's own signal, counted where the fact leaves the process —
      // per tenant, since the sweep is per tenant and one tenant's backlog is
      // the thing an operator asks about.
      const relayed = meter.createCounter("btravstack.outbox.relayed");
      let stopped = false;
      let wake: (() => void) | undefined;
      const sleep = (): Promise<void> =>
        new Promise((resolve) => {
          // The timer is cleared on an early wake and `unref`ed besides: a
          // stray timeout would keep the event loop alive past `stop()` for up
          // to `pollMs`, and an idle relay must not pin the process on its own.
          const timer = setTimeout(resolve, pollMs);
          timer.unref();
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });

      const sweepTenant = async (tenantId: TenantId): Promise<void> => {
        await outbox.pending(tenantId, BATCH).match({
          ok: async (events) => {
            const published: number[] = [];
            for (const event of events) {
              await client
                .publish("orderChanged", {
                  kind: event.kind,
                  id: event.subjectId,
                  occurredAt: event.occurredAt.toISOString(),
                  payload: event.payload,
                  tenantId: event.tenantId,
                })
                .match({
                  ok: () => {
                    published.push(event.id);
                    relayed.add(1, { "btravstack.tenant_id": event.tenantId });
                  },
                  errCases: (matcher) =>
                    matcher.with(P.tag("@amqp-contract/MessageValidationError"), (error) => {
                      logger.error(
                        "an outbox event does not fit the contract; left pending",
                        { eventId: event.id },
                        error,
                      );
                    }),
                  defect: (cause) => {
                    // `warn`, not `error`: the broker refusing a publish is
                    // retryable and the next sweep takes it — and a warning
                    // carries its cause like any other line, which is what the
                    // uniform `(message, attributes, cause)` is for.
                    logger.warn(
                      "publishing an outbox event failed, will retry",
                      { eventId: event.id },
                      cause,
                    );
                  },
                });
            }
            if (published.length > 0) {
              await outbox.markPublished(published).match({
                ok: () => {},
                // `E = never`: the untouched builder is already exhaustive.
                errCases: (matcher) => matcher,
                defect: (cause) => {
                  logger.error(
                    "marking outbox events published failed",
                    { count: published.length },
                    cause,
                  );
                },
              });
            }
          },
          errCases: (matcher) => matcher,
          defect: (cause) => {
            logger.warn("reading the outbox failed, will retry", { tenantId }, cause);
          },
        });
      };

      // Tenant by tenant, each with its own `BATCH`, so one tenant's backlog
      // cannot starve another's — the reason the relay is told which tenants
      // it serves rather than reading the table.
      const sweep = async (): Promise<void> => {
        for (const tenantId of tenants) await sweepTenant(tenantId);
      };

      const running = (async () => {
        while (!stopped) {
          await sweep();
          if (!stopped) await sleep();
        }
      })();

      return {
        stop: () =>
          fromSafePromise(
            (async () => {
              stopped = true;
              wake?.();
              await running;
            })(),
          ).flatMap(() => client.close()),
      };
    });

/**
 * The relay as a resourceful provider: acquired as the graph builds — from the
 * outbox it sweeps, the logger, the broker `amqp()` bound and its own poll
 * interval — and released when the application scope closes. That is AFTER
 * the consumer stopped, not before, and it is fine: the relay's client holds
 * its own lease on the shared connection, and pending rows published during
 * the drain window are safer out than abandoned to the next boot. A broker it
 * cannot reach fails startup, as it always did. `stop().get()` is the
 * `Promise<void>` a finaliser speaks, rejecting only on a defect — which the
 * kernel then reports as a `teardownError`.
 */
export const outboxRelay = Provider(OutboxRelay)({
  inject: {
    outbox: Outbox,
    logger: Logger,
    meter: Meter,
    broker: AmqpConfig,
    config: relayConfig.port,
  },
  acquire: ({ outbox, logger, meter, broker: { url }, config: { pollMs, tenants } }) =>
    startOutboxRelay(outbox, logger, meter, { url, pollMs, tenants: tenantsOf(tenants) }),
  release: (running) => running.stop().get(),
});
