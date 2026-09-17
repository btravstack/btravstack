import { observe, type Operation, type Settle } from "@btravstack/core";

/**
 * A Prisma 8 middleware, structurally — `name`, `familyId` and the one hook
 * this starter implements.
 *
 * Declared here rather than imported from `@prisma/orm-postgres/family-runtime`
 * so the option's type does not drag the target package into a consumer that
 * only reads this module's types. A real `SqlMiddleware` satisfies it.
 */
export type SqlMiddlewareLike = {
  readonly name: string;
  readonly familyId: "sql";
  readonly afterQuery: (plan: unknown, result: QueryResult, ctx: unknown) => Promise<void>;
};

/**
 * What `afterQuery` is told about the query that just ran.
 *
 * There is no error here, and that is Prisma's shape rather than an omission:
 * `AfterQueryResult` is `{ latencyMs, source, rowCount, completed }` and
 * nothing else, so a failed query is reported as `completed: false` with no
 * cause to attach. `ctx` carries the runtime's own logger, not the error.
 */
type QueryResult = {
  readonly completed: boolean;
  readonly rowCount?: number;
  readonly latencyMs?: number;
  readonly source?: string;
};

/**
 * Every query, handed to the graph's observers: a count of how it came out, and
 * a log line if it failed.
 *
 * **This is why a client the starter cannot name can be instrumented at all.**
 * `middleware` is a construction option rather than a wrapper, and a hook sees
 * every query on both lanes — the ORM's and the SQL builder's, the raw lane
 * included — so it never needs to know the contract, which is the thing this
 * package cannot see.
 *
 * **It deliberately opens no span, and it no longer defers to an engine.** The
 * v7 wrapper left tracing to `@prisma/instrumentation`, which traced below what
 * a client-level wrapper could see. Prisma 8 is a TypeScript runtime with no
 * engine and ships no telemetry package: this hook, with the latency the
 * runtime already measured, is the whole seam. A span here would be the one
 * span, not a second one — and is still not opened, because `Observers` is
 * where a graph decides that (`@btravstack/observability/otel` opens one from
 * the same operation).
 *
 * `completed` is what settles the outcome. A failed query still reaches the
 * hook, which is what keeps the errors half of RED honest.
 */
export const queryObserver = (
  observers: readonly ((operation: Operation) => Settle)[],
): SqlMiddlewareLike => ({
  name: "btravstack-observers",
  familyId: "sql",
  // eslint is not the gate here; `async` is Prisma's own hook signature.
  afterQuery: (_plan, result) => {
    // Started and settled in one call: the runtime has already measured the
    // query by the time the hook runs, so there is no window to observe. The
    // duration an observer records is its own.
    //
    // `rows` and `latencyMs` are DETAILS, not attributes. An attribute is a
    // bounded metric dimension — a row count and a millisecond reading are
    // neither, and one time series per value is how a metrics bill becomes the
    // incident. `source` is bounded (`'driver' | 'middleware'`) and a dimension
    // worth having: it is what tells a cache hit from a real query.
    const settle = observe(observers, {
      component: "database",
      name: "query",
      attributes: { source: result.source ?? "driver" },
      details: {
        rows: result.rowCount ?? 0,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      },
    });
    settle(result.completed ? { outcome: "ok" } : { outcome: "error" });
    return Promise.resolve();
  },
});
