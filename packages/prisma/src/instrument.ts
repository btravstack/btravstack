import { observe, type Operation, type Settle } from "@btravstack/core";

/**
 * A Prisma 8 middleware, structurally — `name`, `familyId` and the four hooks
 * this starter implements.
 *
 * Declared here rather than imported from `@prisma/orm-postgres/family-runtime`
 * so the option's type does not drag the target package into a consumer that
 * only reads this module's types. A real `SqlMiddleware` satisfies it.
 */
export type SqlMiddlewareLike = {
  readonly name: string;
  readonly familyId: "sql";
  readonly beforeQuery: (plan: Plan, ctx: MiddlewareContext) => Promise<void>;
  readonly afterQuery: (plan: Plan, result: Settled, ctx: MiddlewareContext) => Promise<void>;
  readonly beforeExecute: (plan: Plan, ctx: MiddlewareContext) => Promise<void>;
  readonly afterExecute: (plan: Plan, result: Settled, ctx: MiddlewareContext) => Promise<void>;
};

/** The rendered statement, which both `before` hooks are handed. */
type Plan = { readonly sql?: string };

/**
 * What every hook is handed. `planExecutionId` is the runtime's own correlation
 * id — its TSDoc names tracing and timing as the reason it exists — and it is
 * what pairs a `before` with its `after`.
 */
type MiddlewareContext = {
  readonly planExecutionId: string;
  readonly scope?: "runtime" | "connection" | "transaction";
};

/** What an `after` hook reports. There is no error here: Prisma's shape carries none. */
type Settled = { readonly completed: boolean; readonly source?: string };

/**
 * Every query, handed to the graph's observers: a span that spans the query, a
 * count of how it came out, and a log line if it failed.
 *
 * **This is why a client the starter cannot name can be instrumented at all.**
 * `middleware` is a construction option rather than a wrapper, and a hook sees
 * every statement on every lane — the ORM's, the SQL builder's and the raw
 * one — so it never needs to know the contract, which is the thing this package
 * cannot see.
 *
 * **It starts the operation in `beforeQuery` and settles it in `afterQuery`**,
 * paired by `ctx.planExecutionId`, because that is what `Observers` is for: the
 * port is called at the START and answers a finisher, so an observer can open a
 * span the query runs *inside*. Settling a span reconstructed afterwards from a
 * duration would make it the parent of nothing. It is also why the runtime's
 * own `latencyMs` is not reported — the observer started the operation, so the
 * duration is its own measurement rather than something to pass along.
 *
 * **Both lanes, because there are two.** A read settles through
 * `afterQuery`; a write with no `RETURNING` — a SQL-builder `delete()` run
 * through `runtime().execute(plan)` — settles through `afterExecute` and would
 * otherwise go unobserved entirely.
 *
 * `completed` is what settles the outcome, and a failed statement does reach
 * the hook: measured against a real database, a duplicate insert arrives as
 * `afterQuery … completed=false` before the rejection surfaces. That is what
 * keeps the errors half of RED honest.
 */
export const queryObserver = (
  observers: readonly ((operation: Operation) => Settle)[],
): SqlMiddlewareLike => {
  // One entry per statement in flight, removed by its own `after` hook. The
  // hooks are measured to fire in pairs on success, on failure, and on a cache
  // hit (`source: "middleware"`), so the only way an entry outlives its
  // statement is a runtime torn down mid-query — bounded by what was in flight.
  const open = new Map<string, Settle>();

  const start = (plan: Plan, ctx: MiddlewareContext): Promise<void> => {
    open.set(
      ctx.planExecutionId,
      observe(observers, {
        component: "database",
        name: "query",
        // `scope` is the runtime's own closed set, so it is a dimension worth
        // having: it separates a statement inside a transaction from one that
        // stands alone. The row count is NOT here — it is unbounded, and one
        // time series per row count is how a metrics bill becomes the incident.
        attributes: { scope: ctx.scope ?? "runtime" },
        // The statement, for the span and the failure line only. Parameters are
        // bound separately, so this carries placeholders rather than values.
        ...(plan.sql === undefined ? {} : { details: { sql: plan.sql } }),
      }),
    );
    return Promise.resolve();
  };

  const finish = (_plan: Plan, result: Settled, ctx: MiddlewareContext): Promise<void> => {
    const settle = open.get(ctx.planExecutionId);
    open.delete(ctx.planExecutionId);
    settle?.({
      outcome: result.completed ? "ok" : "error",
      // Known only at the end, and bounded — `'driver'` or `'middleware'`,
      // which is what tells a real query from one a cache middleware answered.
      ...(result.source === undefined ? {} : { attributes: { source: result.source } }),
    });
    return Promise.resolve();
  };

  return {
    name: "btravstack-observers",
    familyId: "sql",
    beforeQuery: start,
    afterQuery: finish,
    beforeExecute: start,
    afterExecute: finish,
  };
};
