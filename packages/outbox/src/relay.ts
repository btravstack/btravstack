import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import {
  HealthCheckFailed,
  HealthChecks,
  Observers,
  noObserverMember,
  observed,
  systemClock,
  type Clock,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope } from "@btravstack/di";
import { ErrAsync, OkAsync, allAsync, fromSafePromise, type AsyncResult } from "unthrown";

import {
  OutboxPublisher,
  OutboxStore,
  type OutboxMessage,
  type OutboxPublisherService,
  type OutboxStoreService,
} from "./outbox.js";

/** How many messages one claim hands the publisher. */
const BATCH = 32;

/** The ceiling the back-off doubles towards, unless the poll interval is already longer. */
const MAX_BACKOFF_MS = 30_000;

/** What {@link outbox} is handed. Each field pins the variable named beside it. */
export type OutboxOptions = {
  /** The tenants this relay serves — `OUTBOX_TENANTS`, comma-separated, required. */
  readonly tenants?: readonly string[];
  /** The idle sleep between sweeps — `OUTBOX_POLL_MS` (default `200`). */
  readonly pollMs?: number;
  /** The oldest pending age `/healthz` tolerates — `OUTBOX_MAX_LAG_MS` (default `60_000`). */
  readonly maxLagMs?: number;
  /** What the poll sleeps on and the lag is measured against (default: the kernel's `systemClock`). */
  readonly clock?: Clock;
};

class OutboxConfig extends Port("OutboxConfig")<{
  readonly tenants: readonly string[];
  readonly pollMs: number;
  readonly maxLagMs: number;
}> {}

/** The running relay. Nothing resolves it; it exists to be started and stopped. */
class OutboxRelay extends Port("OutboxRelay")<{
  readonly stop: () => AsyncResult<void, never>;
}> {}

type Observer = (operation: Operation) => Settle;

/** A tenant is bounded — the relay is told its tenants — so it rides the instruments; the subject does not. */
const publishing = (message: OutboxMessage): Operation => ({
  component: "outbox",
  name: "publish",
  attributes: { kind: message.kind, "btravstack.tenant_id": message.tenantId },
  details: { "btravstack.outbox.id": message.id, "btravstack.outbox.subject": message.subjectId },
});

/** Not traced: one span per tenant per poll would bury the publishes it contains. */
const claiming = (tenantId: string): Operation => ({
  component: "outbox",
  name: "claim",
  attributes: { "btravstack.tenant_id": tenantId },
  traced: false,
});

type Swept = "idle" | "full" | "failed";

const startRelay = (
  store: OutboxStoreService,
  publisher: OutboxPublisherService,
  observers: readonly Observer[],
  clock: Clock,
  { tenants, pollMs }: { readonly tenants: readonly string[]; readonly pollMs: number },
) => {
  const stopping = new AbortController();
  const { signal } = stopping;

  // In order, and stopping at the first refusal: publishing the rest would let
  // a later fact about a subject overtake the one still pending.
  const publishInOrder = async (batch: readonly OutboxMessage[]): Promise<readonly number[]> => {
    const published: number[] = [];
    for (const message of batch) {
      const sent = await observed(observers, publishing(message), () => publisher.publish(message));
      if (!sent.isOk()) break;
      published.push(message.id);
    }
    return published;
  };

  const sweep = async (tenantId: string): Promise<Swept> => {
    let swept: Swept = "idle";
    const claimed = await observed(observers, claiming(tenantId), () =>
      store.claim(tenantId, BATCH, (batch) =>
        fromSafePromise(
          publishInOrder(batch).then((published) => {
            swept =
              published.length < batch.length ? "failed" : batch.length === BATCH ? "full" : "idle";
            return published;
          }),
        ),
      ),
    );
    return claimed.isOk() ? swept : "failed";
  };

  const running = (async () => {
    let failures = 0;
    while (!signal.aborted) {
      const swept: Swept[] = [];
      for (const tenantId of tenants) {
        if (signal.aborted) break;
        swept.push(await sweep(tenantId));
      }
      failures = swept.includes("failed") ? failures + 1 : 0;
      // A full batch means a backlog, so the next sweep starts at once.
      if (failures === 0 && swept.includes("full")) continue;
      await clock.sleep(Math.min(pollMs * 2 ** failures, Math.max(pollMs, MAX_BACKOFF_MS)), signal);
    }
  })();

  return {
    stop: () =>
      fromSafePromise(
        (async () => {
          stopping.abort();
          await running;
        })(),
      ),
  };
};

/**
 * The outbox relay: the other half of a write that recorded its fact in the
 * same transaction as the row it describes. It claims each tenant's oldest
 * pending messages, hands them to the application's {@link OutboxPublisher}
 * in outbox order, marks published what was published, and sleeps.
 *
 * ```ts
 * outbox({ tenants: ["acme"] });
 * ```
 *
 * **At-least-once, and never twice at once.** A crash between a publish and
 * its mark re-publishes on the next claim, so a subscriber must tolerate a
 * repeat. What the claim rules out is the other source of repeats: N replicas
 * sweeping one table each publishing the same row. A tenant is claimed by one
 * relay at a time and skipped by the rest, which also keeps a tenant's facts in
 * order across replicas.
 *
 * **A refused publish stops the tenant's batch** and backs off, doubling from
 * the poll interval to 30 seconds, so a later fact never overtakes an earlier
 * one. A message the publisher refuses forever therefore holds its tenant's
 * outbox — which is what the health check is for: it reports a tenant whose
 * oldest pending message is older than `maxLagMs`.
 *
 * Started as the graph builds, before the runtime accepts anything, and
 * stopped when the application scope closes, after the runtime has drained.
 * Every claim and publish is reported to `Observers`; the module holds no
 * logger of its own.
 */
export const outbox = (
  options: OutboxOptions = {},
): Module<HealthChecks, ConfigInvalid, Env | OutboxStore | OutboxPublisher | Scope> => {
  const clock = options.clock ?? systemClock;
  const config = Config.provider(OutboxConfig)(
    Config.object({
      tenants: Config.pinned(options.tenants, Config.list("OUTBOX_TENANTS")),
      pollMs: Config.pinned(
        options.pollMs,
        Config.integer("OUTBOX_POLL_MS", { min: 1, max: 60_000, default: 200 }),
      ),
      maxLagMs: Config.pinned(
        options.maxLagMs,
        Config.integer("OUTBOX_MAX_LAG_MS", { min: 1, default: 60_000 }),
      ),
    }),
  );

  const relay = Provider(OutboxRelay)({
    inject: {
      store: OutboxStore,
      publisher: OutboxPublisher,
      observers: Observers,
      config: OutboxConfig,
    },
    acquire: ({ store, publisher, observers, config: bound }) =>
      OkAsync(startRelay(store, publisher, observers, clock, bound)),
    release: (running) => running.stop().get(),
  });

  const healthCheck = Provider.member(HealthChecks)({
    inject: { store: OutboxStore, config: OutboxConfig },
    sync: ({ store, config: { tenants, maxLagMs } }) => ({
      name: "outbox",
      check: () =>
        allAsync(
          tenants.map((tenantId) =>
            store.pending(tenantId, 1).map(([oldest]) => ({
              tenantId,
              lagMs: oldest === undefined ? 0 : clock.now() - oldest.occurredAt.getTime(),
            })),
          ),
        ).flatMap((lags) => {
          const behind = lags.filter(({ lagMs }) => lagMs > maxLagMs);
          return behind.length === 0
            ? OkAsync()
            : ErrAsync(
                new HealthCheckFailed({
                  reason: behind
                    .map(({ tenantId, lagMs }) => `${tenantId} is ${String(lagMs)} ms behind`)
                    .join(", "),
                }),
              );
        }),
    }),
  });

  return Module("Outbox")({
    needs: [Env, OutboxStore, OutboxPublisher],
    provides: [config, noObserverMember, relay, healthCheck],
    exports: [HealthChecks],
  });
};
