import { AsyncLocalStorage } from "node:async_hooks";

import { OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

export type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly deadline: number | undefined;
};

const storage = new AsyncLocalStorage<UnitRecord>();

export const runWithUnit = <T>(record: UnitRecord, fn: () => T): T => storage.run(record, fn);

export const currentUnit = (): UnitRecord | undefined => storage.getStore();

export type UnitMeta = {
  readonly kind: string;
  readonly id: string;
  readonly traceId?: string;
  readonly tenantId?: string;
  readonly deadline?: number;
};

export type UnitWork<T, E> = (
  signal: AbortSignal,
  // oxlint-disable-next-line unthrown/prefer-async-result -- function-type return position: an ordinary `async` work callback returns `Promise<Result<T, E>>` natively, and `run` awaits it internally, so forcing `AsyncResult` here would not compile at call sites
) => AsyncResult<T, E> | Promise<Result<T, E>> | Result<T, E>;

export type UnitRegistry = {
  readonly run: <T, E>(meta: UnitMeta, work: UnitWork<T, E>) => AsyncResult<T, E>;
  readonly inFlight: () => number;
  // Monotonic: only ever increments, so `closed() - closedAtSomeEarlierPoint`
  // can never go negative the way `inFlightAtStart - inFlight()` can (a unit
  // that starts after the earlier point is sampled shrinks the latter below
  // zero; it only grows the former).
  readonly closed: () => number;
  readonly abortAll: () => void;
  readonly awaitIdle: () => AsyncResult<void, never>;
};

let counter = 0;

const nextId = (): string => {
  counter += 1;
  return `u${counter}`;
};

export const createUnitRegistry = (): UnitRegistry => {
  const open = new Set<AbortController>();
  const idleWaiters = new Set<() => void>();
  let closedCount = 0;

  const settleIfIdle = (): void => {
    if (open.size > 0) return;
    for (const waiter of idleWaiters) waiter();
    idleWaiters.clear();
  };

  return {
    run: (meta, work) => {
      const controller = new AbortController();
      open.add(controller);

      const record: UnitRecord = {
        unitId: nextId(),
        traceId: meta.traceId ?? meta.id,
        tenantId: meta.tenantId,
        deadline: meta.deadline,
      };

      // `fromSafePromise` is correct rather than `fromPromise`: the promise
      // below cannot reject — the work's own throw is caught by `flatMap`'s
      // throw-to-defect net once the inner Result is unwrapped — and there is
      // no cause here that a `qualify` could triage into a modeled error.
      return fromSafePromise(
        runWithUnit(record, async () => {
          try {
            return await work(controller.signal);
          } finally {
            // Same `finally` as the delete: every path a unit can leave by —
            // Ok, Err, or a throw — closes it exactly once, here.
            open.delete(controller);
            closedCount += 1;
            settleIfIdle();
          }
        }),
      ).flatMap((result) => result);
    },
    inFlight: () => open.size,
    closed: () => closedCount,
    abortAll: () => {
      // `open` is iterated live: a unit started synchronously from an abort
      // listener is visited and aborted by this same pass too.
      for (const controller of open) controller.abort();
    },
    awaitIdle: () =>
      open.size === 0
        ? OkAsync()
        : fromSafePromise(
            new Promise<void>((resolve) => {
              idleWaiters.add(resolve);
            }),
          ),
  };
};
