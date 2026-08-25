import { AsyncLocalStorage } from "node:async_hooks";

import { OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

/**
 * What the kernel opens per unit and `currentUnit()` reads: a small, fixed
 * record of **data about this unit**, and never a service.
 *
 * `signal` is the same `AbortSignal` the work callback receives — aborted at
 * the drain deadline, or at once on a path that skips the drain. It is here
 * because the callback is not always where the work is: a middleware-shaped
 * runtime opens the unit around a call whose arguments it does not own. A
 * transport's own cancellation is a different clock, not this one.
 */
export type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly deadline: number | undefined;
  readonly signal: AbortSignal;
};

const storage = new AsyncLocalStorage<UnitRecord>();

export const runWithUnit = <T>(record: UnitRecord, fn: () => T): T => storage.run(record, fn);

export const currentUnit = (): UnitRecord | undefined => storage.getStore();

/**
 * What a runtime says about one piece of work as it submits it. `kind` is the
 * category (`"http"`, `"tick"`, `"job"`); `id` identifies **this** unit.
 *
 * @remarks
 * **`id` must be unique per unit unless a `traceId` is supplied**, because
 * `traceId` defaults to it. A runtime passing a CATEGORY as the id — a route
 * template such as `"POST /orders"` — gives every request the same trace id and
 * silently defeats the ambient record. A route template is a `kind`.
 *
 * The kernel cannot check this, so uniqueness is the runtime's to guarantee.
 * What it does guarantee is {@link UnitRecord}'s `unitId`, minted per unit;
 * `traceId` is the CORRELATION id, which is why it is the one a runtime may
 * supply — it carries an id from outside the process.
 */
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
  // Monotonic, so a delta of it can never go negative the way
  // `inFlightAtStart - inFlight()` can once a unit starts after the sample.
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
        // The very signal `work` is handed below: one abort, two ways to reach
        // it. Do not mirror it onto a second controller.
        signal: controller.signal,
      };

      // `fromSafePromise`, not `fromPromise`: the promise cannot reject — the
      // work's own throw is caught by `flatMap`'s throw-to-defect net — and no
      // cause here could be triaged into a modeled error.
      return fromSafePromise(
        runWithUnit(record, async () => {
          try {
            return await work(controller.signal);
          } finally {
            // Every path a unit can leave by — Ok, Err or a throw — closes it
            // exactly once, here.
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
