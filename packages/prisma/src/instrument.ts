import { observe, type Operation, type Settle } from "@btravstack/core";

/**
 * A Prisma 8 SQL middleware, structurally, with the hooks of BOTH release
 * trains the peer range admits.
 *
 * Prisma 8.0.0-rc.18 replaced the per-statement hooks: `beforeQuery` and
 * `beforeExecute` became `beforeEncode`, `afterQuery` and `afterExecute`
 * became `activityEnded`. The two sets are disjoint and neither runtime refuses
 * a hook it does not know, so one object serves both: each runtime calls its
 * own pair and never the other's. Declared here rather than imported so the
 * option's type drags no target package into a consumer.
 */
export type SqlMiddlewareLike = {
  readonly name: string;
  readonly familyId: "sql";
  /** rc.18 and later: before the statement's parameters are encoded, on both lanes. */
  readonly beforeEncode: (plan: Plan, ctx: ActivityContext) => Promise<void>;
  /** rc.18 and later: a statement, transaction or client activity ended. */
  readonly activityEnded: (
    activity: { readonly kind: string },
    result: ActivityEnded,
    ctx: ActivityContext,
  ) => Promise<void>;
  /** rc.11 to rc.17: a statement read for its rows. */
  readonly beforeQuery: (plan: Plan, ctx: PlanContext) => Promise<void>;
  readonly afterQuery: (plan: Plan, result: Completed, ctx: PlanContext) => Promise<void>;
  /** rc.11 to rc.17: a statement run for its statistics, such as a write with no `RETURNING`. */
  readonly beforeExecute: (plan: Plan, ctx: PlanContext) => Promise<void>;
  readonly afterExecute: (plan: Plan, result: Completed, ctx: PlanContext) => Promise<void>;
};

/**
 * Every statement, handed to the graph's observers: a span around it, a count
 * of how it came out, and a log line if it failed.
 *
 * The operation STARTS before the driver runs and settles after it, because
 * `Observers` answers a finisher precisely so a span can be opened around the
 * work. On rc.18 the finisher rides the activity's own `ctx.state`. On rc.11 it
 * is keyed WEAKLY by the operation's context, the one object every hook of a
 * statement is handed: a statement refused after `beforeQuery` (a later
 * middleware, a codec, an abort) never reaches `afterQuery`, and a map keyed by
 * `planExecutionId` would keep its finisher for the client's lifetime.
 */
export const queryObserver = (
  observers: readonly ((operation: Operation) => Settle)[],
): SqlMiddlewareLike => {
  const key = Symbol("btravstack-query-observer");
  const inFlight = new WeakMap<PlanContext, Settle>();

  const start = (plan: Plan, scope: Scope | undefined): Settle =>
    observe(observers, {
      component: "database",
      name: "query",
      // A closed set, so a dimension; the row count is unbounded and is not one.
      attributes: { scope: scope ?? "runtime" },
      // Placeholders rather than values: parameters are bound separately.
      ...(plan.sql === undefined ? {} : { details: { sql: plan.sql } }),
    });

  const settle = (finish: Settle | undefined, ok: boolean, source: string | undefined): void => {
    finish?.({
      outcome: ok ? "ok" : "error",
      ...(source === undefined ? {} : { attributes: { source } }),
    });
  };

  const beforePlan = (plan: Plan, ctx: PlanContext): Promise<void> => {
    inFlight.set(ctx, start(plan, ctx.scope));
    return Promise.resolve();
  };

  const afterPlan = (_plan: Plan, result: Completed, ctx: PlanContext): Promise<void> => {
    const finish = inFlight.get(ctx);
    inFlight.delete(ctx);
    settle(finish, result.completed, result.source);
    return Promise.resolve();
  };

  return {
    name: "btravstack-observers",
    familyId: "sql",
    beforeEncode: (plan, ctx) => {
      ctx.state(key)["settle"] = start(plan, ctx.scope);
      return Promise.resolve();
    },
    activityEnded: (_activity, result, ctx) => {
      if (result.kind === "statement") {
        const state = ctx.state(key);
        const finish = state["settle"] as Settle | undefined;
        delete state["settle"];
        settle(finish, result.outcome === "succeeded", result.source);
      }
      return Promise.resolve();
    },
    beforeQuery: beforePlan,
    afterQuery: afterPlan,
    beforeExecute: beforePlan,
    afterExecute: afterPlan,
  };
};

type Plan = { readonly sql?: string };
type Scope = "runtime" | "connection" | "transaction";
type ActivityContext = {
  readonly scope?: Scope;
  readonly state: (key: string | symbol) => Record<string | symbol, unknown>;
};
type ActivityEnded =
  | {
      readonly kind: "statement";
      readonly outcome: "succeeded" | "failed" | "stopped";
      readonly source?: string;
    }
  | { readonly kind: "transaction" | `${string}-${string}` };
type PlanContext = { readonly scope?: Scope };
type Completed = { readonly completed: boolean; readonly source?: string };
