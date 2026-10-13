import { randomUUID } from "node:crypto";

import {
  Config,
  Env,
  type ConfigInvalid,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import {
  HealthCheckFailed,
  HealthChecks,
  RuntimePort,
  releasedBy,
  type Runtime,
  type RuntimeHost,
  Observers,
  noObserverMember,
  observed,
  systemClock,
  type Clock,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope } from "@btravstack/di";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

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

/** How many published rows one prune deletes, so no sweep holds a long lock. */
const PRUNE_BATCH = 1_000;

const PRUNE_EVERY_MS = 60_000;

// While a batch comes back full: often enough to outpace a busy tenant's
// publishes, which a minute's single batch would not, and still paced.
const PRUNE_BACKLOG_MS = 1_000;

/** What {@link outbox} is handed. Each field pins the variable named beside it. */
export type OutboxOptions = {
  /** The tenants this relay serves — `OUTBOX_TENANTS`, comma-separated, required. */
  readonly tenants?: readonly string[] | undefined;
  /** The idle sleep between sweeps — `OUTBOX_POLL_MS` (default `200`). */
  readonly pollMs?: number;
  /** The oldest pending age `/healthz` tolerates — `OUTBOX_MAX_LAG_MS` (default `60_000`). */
  readonly maxLagMs?: number;
  /**
   * How long a published row is kept before the relay deletes it —
   * `OUTBOX_RETAIN_MS` (default `0`: kept). `false` pins it off whatever the
   * deployment sets.
   */
  readonly retainMs?: number | false;
  /** How many tenants hold a claim at once — `OUTBOX_CONCURRENCY` (default `4`). */
  readonly concurrency?: number;
  /** What the poll sleeps on and the lag is measured against (default: the kernel's `systemClock`). */
  readonly clock?: Clock;
};

class OutboxConfig extends Port("OutboxConfig")<{
  readonly tenants: readonly string[];
  readonly pollMs: number;
  readonly maxLagMs: number;
  readonly retainMs: number;
  readonly concurrency: number;
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
  attributes: {
    operation: "publish",
    kind: message.kind,
    "btravstack.tenant_id": message.tenantId,
  },
  details: { "btravstack.outbox.id": message.id, "btravstack.outbox.subject": message.subjectId },
});

/** Not traced, for the claim's reason: one span per tenant per minute says nothing. */
const pruning = (tenantId: string): Operation => ({
  component: "outbox",
  name: "prune",
  attributes: { operation: "prune", "btravstack.tenant_id": tenantId },
  traced: false,
});

/** Not traced: one span per tenant per poll would bury the publishes it contains. */
const claiming = (tenantId: string): Operation => ({
  component: "outbox",
  name: "claim",
  attributes: { operation: "claim", "btravstack.tenant_id": tenantId },
  traced: false,
});

type Swept = "idle" | "full" | "failed";

const startRelay = (
  store: OutboxStoreService,
  publisher: OutboxPublisherService,
  observers: readonly Observer[],
  clock: Clock,
  {
    tenants,
    pollMs,
    retainMs,
    concurrency,
  }: {
    readonly tenants: readonly string[];
    readonly pollMs: number;
    readonly retainMs: number;
    readonly concurrency: number;
  },
  run?: RuntimeHost<never>["run"],
) => {
  const stopping = new AbortController();
  const { signal } = stopping;

  // A freed slot passes straight to the longest waiter rather than back to the
  // pool, so a tenant whose batch came back full queues behind the others
  // instead of retaking it. A stop answers every waiter `false` at once.
  let free = concurrency;
  const waiting: ((granted: boolean) => void)[] = [];
  signal.addEventListener("abort", () => {
    for (const wake of waiting.splice(0)) wake(false);
  });
  const take = (): Promise<boolean> => {
    if (free === 0) return new Promise((wake) => waiting.push(wake));
    free -= 1;
    return Promise.resolve(true);
  };
  const give = (): void => {
    const next = waiting.shift();
    if (next) next(true);
    else free += 1;
  };

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
    const claim = () =>
      observed(observers, claiming(tenantId), () =>
        store.claim(tenantId, BATCH, (batch) =>
          fromSafePromise(
            publishInOrder(batch).then((published) => {
              swept =
                published.length < batch.length
                  ? "failed"
                  : batch.length === BATCH
                    ? "full"
                    : "idle";
              return published;
            }),
          ),
        ),
      );
    const claimed = await (run
      ? run({ id: randomUUID(), kind: "outbox", tenantId }, claim)
      : claim());
    return claimed.isOk() ? swept : "failed";
  };

  // One batch per round: a long history is deleted between sweeps rather than
  // ahead of them.
  const prune = async (tenantId: string): Promise<boolean> => {
    const pruned = await observed(observers, pruning(tenantId), () =>
      store.prune(tenantId, retainMs, PRUNE_BATCH),
    );
    return pruned.isOk() && pruned.value === PRUNE_BATCH;
  };

  const backoff = (failures: number): number =>
    Math.min(pollMs * 2 ** failures, Math.max(pollMs, MAX_BACKOFF_MS));

  // One loop per tenant keeps claims serial within a tenant; the slots bound
  // how many claims and prunes, and so pooled connections, are held at once.
  const running = Promise.all(
    tenants.map(async (tenantId) => {
      let due = clock.now();
      let pruneDue = retainMs > 0 ? clock.now() : Number.POSITIVE_INFINITY;
      let swept: Swept = "idle";
      let failures = 0;
      while (!signal.aborted) {
        const wait = Math.min(due, pruneDue) - clock.now();
        if (wait > 0) await clock.sleep(wait, signal);
        if (signal.aborted || !(await take())) break;
        // One slot covers the sweep and the prune: each holds the tenant's
        // lock on a pooled connection.
        try {
          // A slot handed over as the stop landed goes back unused.
          if (signal.aborted) break;
          // Two deadlines: waking to prune must not retry a publish its backoff
          // still holds back.
          if (clock.now() >= due) {
            swept = await sweep(tenantId);
            failures = swept === "failed" ? failures + 1 : 0;
            due = clock.now() + (swept === "full" ? 0 : backoff(failures));
          }
          // Not after a full batch, so a backlog publishes first; after a failed
          // one too, since a refused head message must not hold retention back.
          if (!signal.aborted && swept !== "full" && clock.now() >= pruneDue) {
            const backlog = await prune(tenantId);
            pruneDue = clock.now() + (backlog ? PRUNE_BACKLOG_MS : PRUNE_EVERY_MS);
          }
        } finally {
          give();
        }
      }
    }),
  );

  return {
    finished: fromSafePromise(running).map(() => undefined),
    stop: () =>
      fromSafePromise(
        (async () => {
          stopping.abort();
          await running;
        })(),
      ),
  };
};

const relayModule = <const O extends OutboxOptions, const Standalone extends boolean>(
  standalone: Standalone,
  // `{}` only when the argument is omitted, which is when `O` is `{}` too.
  options: O & OptionsAs<O, OutboxOptions> = {} as never,
): Module<
  HealthChecks | (Standalone extends true ? OutboxRuntime : never),
  ConfigInvalid,
  | EnvReading<
      Unpinned<O, "tenants", "OUTBOX_TENANTS">,
      | MaybePinned<O, "tenants", "OUTBOX_TENANTS">
      | "OUTBOX_POLL_MS"
      | "OUTBOX_MAX_LAG_MS"
      | "OUTBOX_RETAIN_MS"
      | "OUTBOX_CONCURRENCY"
    >
  | OutboxStore
  | OutboxPublisher
  | Scope
> => {
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
      retainMs: Config.pinned(
        options.retainMs === false ? 0 : options.retainMs,
        Config.integer("OUTBOX_RETAIN_MS", { min: 0, default: 0 }),
      ),
      concurrency: Config.pinned(
        options.concurrency,
        Config.integer("OUTBOX_CONCURRENCY", { min: 1, default: 4 }),
      ),
    }),
  );

  const finalizers = new WeakMap<Runtime, () => Promise<void>>();
  const runtime = Provider(OutboxRuntime)({
    inject: {
      store: OutboxStore,
      publisher: OutboxPublisher,
      observers: Observers,
      config: OutboxConfig,
    },
    acquire: ({ store, publisher, observers, config: bound }) => {
      let running: ReturnType<typeof startRelay> | undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        clearInterval(keepAlive);
        return running?.stop() ?? OkAsync();
      };
      const service: Runtime = {
        name: "outbox",
        resolves: [],
        start: (host) => {
          running = startRelay(store, publisher, observers, clock, bound, host.run);
          const active = running;
          keepAlive = setInterval(Boolean, 2 ** 30);
          return OkAsync({
            drain: (signal) => releasedBy(signal, stop()),
            stop,
            // A loop completes normally only after stop; defects still pass through.
            stopped: () =>
              active.finished.flatMap(() => fromSafePromise(new Promise<void>(() => {}))),
          });
        },
      };
      finalizers.set(service, () => stop().get());
      return OkAsync(service);
    },
    release: (service) => finalizers.get(service)!(),
  });

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
        store.oldestPending(tenants).flatMap((oldest) => {
          const behind = oldest
            .map(({ tenantId, occurredAt }) => ({
              tenantId,
              lagMs: clock.now() - occurredAt.getTime(),
            }))
            .filter(({ lagMs }) => lagMs > maxLagMs);
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

  // Cast for the needs alone: over generic options the schema's own needs
  // type cannot resolve, so the annotation states the variables — `OUTBOX_TENANTS`
  // required unless pinned.
  return Module("Outbox")({
    needs: [Env, OutboxStore, OutboxPublisher],
    provides: [config, noObserverMember, ...(standalone ? [runtime] : [relay]), healthCheck],
    exports: [HealthChecks, ...(standalone ? [OutboxRuntime] : [])],
  }) as never;
};

/** The standalone relay's runtime port, sharing the kernel's one runtime id. */
export class OutboxRuntime extends RuntimePort<Runtime> {}

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
 * **At-least-once, with replicas taking turns.** A crash between a publish and
 * its mark re-publishes on the next claim, and so does a claiming session the
 * database ends mid-batch, so a subscriber must tolerate a repeat, keyed by the
 * outbox id. What the claim rules out is replicas racing: a tenant is held by
 * one relay while its claiming session lives and skipped by the rest, so its
 * committed facts go out in outbox order — which is not commit order: an id
 * still in an open transaction surfaces after a higher one that committed.
 *
 * **A refused publish stops the tenant's batch** and backs that tenant off,
 * doubling from the poll interval to 30 seconds, so a later fact never
 * overtakes an earlier one. A message the publisher refuses forever therefore
 * holds its tenant's outbox — which is what the health check is for: it
 * reports a tenant whose oldest pending message is older than `maxLagMs`.
 *
 * **At most `concurrency` tenants hold a claim or a prune at once**, each on
 * one pooled connection for its whole batch; the rest wait their turn in
 * order. The
 * default of 4 leaves most of a 10-connection pool to the publisher and the
 * requests sharing it. A publish that never settles holds its slot, so a
 * publisher that can hang answers `Err` on a timeout of its own.
 *
 * Started as the graph builds, before the runtime accepts anything, and
 * stopped when the application scope closes, after the runtime has drained.
 * Every claim and publish is reported to `Observers`; the module holds no
 * logger of its own.
 */
export const outbox = <const O extends OutboxOptions = Record<never, never>>(
  options: O & OptionsAs<O, OutboxOptions> = {} as never,
) => relayModule(false, options);

/**
 * Run the relay as the process's only runtime. Export `OutboxRuntime` and
 * `HealthChecks` from the application root and pass it to `runMain`.
 * Polling starts at runtime startup, stops at drain, and the current claims
 * are awaited up to the drain deadline. Scope teardown still waits for claims
 * before releasing the store and publisher, bounded by `stopTimeoutMs`.
 */
export const outboxRuntime = <const O extends OutboxOptions = Record<never, never>>(
  options: O & OptionsAs<O, OutboxOptions> = {} as never,
) => relayModule(true, options);
