import { TypedAmqpClient } from "@amqp-contract/client";
import { AmqpConfig } from "@btravstack/amqp";
import { Config } from "@btravstack/config";
import { Port, Provider, type ServiceOf } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Logger, Outbox } from "@btravstack/example-order-application";
import { P, fromSafePromise, type AsyncResult } from "unthrown";

/**
 * What only the relay knows, as a service: its idle sleep, bound from
 * `OUTBOX_POLL_MS`. `0` is rejected — a relay that never sleeps is a busy
 * loop — and so is anything above a minute, which is a typo, not a policy.
 * `Config.provider(name)(schema)` mints the port (`relayConfig.port`): the
 * slice is this deployment's own, so nothing else ever names it.
 */
export const relayConfig = Config.provider("RelayConfig")(
  Config.object({
    pollMs: Config.integer("OUTBOX_POLL_MS", { min: 1, max: 60_000, default: 200 }),
  }),
);

/** The running relay: nothing resolves it, and nothing needs to — it exists to be started and stopped. */
export class OutboxRelay extends Port("OutboxRelay")<{
  readonly stop: () => AsyncResult<void, never>;
}> {}

/** How many outbox rows one sweep publishes before sleeping. */
const BATCH = 32;

/**
 * The other half of the outbox pattern: `OrderRepository.save` wrote the fact
 * down, this loop says it out loud. Pull what is pending, publish it to the
 * `orders` exchange, mark it sent — in commit order, forever, until told to
 * stop.
 *
 * The loop is deliberately at-least-once. A crash between publish and
 * `markPublished` re-publishes on the next sweep; a broker outage leaves rows
 * pending and the sweep after the outage drains them. What is *never* possible
 * is the inverse failure — an order committed whose event evaporated — because
 * the event was committed by the same transaction as the order.
 *
 * Failure triage per event, all three channels: published → mark; a
 * validation error → the row cannot ever serialize, a bug worth a log line,
 * left pending so it stays visible; a defect (broker down, mid-flight close)
 * → logged, left pending, retried next sweep.
 *
 * The client is created here rather than injected: a transport connection is
 * the transport's own — `@btravstack/amqp` creates its worker inside
 * `Runtime.start` from the same `AmqpConfig` this reads. It is not a second
 * connection, either: `@amqp-contract/core`'s `ConnectionManagerSingleton`
 * pools by URL and reference-counts leases, so this client and the consumer's
 * worker share one TCP connection and `client.close()` releases a lease rather
 * than closing the socket. What the relay takes from di is everything the
 * application owns — `Outbox` and `Logger`, handed in by `outboxRelay`'s
 * provider — which is the boundary that matters.
 */
const startOutboxRelay = (
  outbox: ServiceOf<Outbox>,
  logger: ServiceOf<Logger>,
  { url, pollMs }: { readonly url: string; readonly pollMs: number },
): AsyncResult<ServiceOf<OutboxRelay>, never> =>
  TypedAmqpClient.create({ contract: orderContract, urls: [url] }).map((client) => {
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

    const sweep = async (): Promise<void> => {
      await outbox.pending(BATCH).match({
        ok: async (events) => {
          const published: number[] = [];
          for (const event of events) {
            await client
              .publish("orderChanged", {
                kind: event.kind,
                id: event.subjectId,
                occurredAt: event.occurredAt.toISOString(),
                payload: event.payload,
              })
              .match({
                ok: () => {
                  published.push(event.id);
                },
                errCases: (matcher) =>
                  matcher.with(P.tag("@amqp-contract/MessageValidationError"), () => {
                    logger.info(`outbox event ${event.id} does not fit the contract; left pending`);
                  }),
                defect: (cause) => {
                  logger.info(
                    `publishing outbox event ${event.id} failed, will retry: ${String(cause)}`,
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
                logger.info(`marking outbox events published failed: ${String(cause)}`);
              },
            });
          }
        },
        errCases: (matcher) => matcher,
        defect: (cause) => {
          logger.info(`reading the outbox failed, will retry: ${String(cause)}`);
        },
      });
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
export const outboxRelay = Provider(OutboxRelay)([Outbox, Logger, AmqpConfig, relayConfig.port], {
  acquire: (outbox, logger, { url }, { pollMs }) =>
    startOutboxRelay(outbox, logger, { url, pollMs }),
  release: (running) => running.stop().get(),
});
