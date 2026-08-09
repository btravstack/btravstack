import { fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { runWithUnit, type UnitRecord } from "./ambient.js";

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
  readonly abortAll: () => void;
  readonly awaitIdle: () => Promise<void>;
};

let counter = 0;

const nextId = (): string => {
  counter += 1;
  return `u${counter}`;
};

export const createUnitRegistry = (): UnitRegistry => {
  const open = new Set<AbortController>();
  const idleWaiters = new Set<() => void>();

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
            open.delete(controller);
            settleIfIdle();
          }
        }),
      ).flatMap((result) => result);
    },
    inFlight: () => open.size,
    abortAll: () => {
      for (const controller of open) controller.abort();
    },
    awaitIdle: () =>
      open.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.add(resolve);
          }),
  };
};
