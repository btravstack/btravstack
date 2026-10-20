import { observe, type Operation, type Settle } from "@btravstack/core";

/** Structural Prisma 8 SQL hooks; no target-package import reaches consumers. */
export type SqlMiddlewareLike = {
  readonly name: string;
  readonly familyId: "sql";
  readonly beforeEncode: (plan: Plan, ctx: MiddlewareContext) => Promise<void>;
  readonly activityEnded: (
    activity: { readonly kind: "statement" | "transaction" },
    result: Settled,
    ctx: MiddlewareContext,
  ) => Promise<void>;
};

/** Observe both SQL lanes from encoding until their statement activity ends. */
export const queryObserver = (
  observers: readonly ((operation: Operation) => Settle)[],
): SqlMiddlewareLike => {
  const key = Symbol("btravstack-query-observer");
  return {
    name: "btravstack-observers",
    familyId: "sql",
    beforeEncode: (plan, ctx) => {
      ctx.state(key)["settle"] = observe(observers, {
        component: "database",
        name: "query",
        attributes: { scope: ctx.scope ?? "runtime" },
        ...(plan.sql === undefined ? {} : { details: { sql: plan.sql } }),
      });
      return Promise.resolve();
    },
    activityEnded: (_activity, result, ctx) => {
      if (result.kind === "statement") {
        const state = ctx.state(key);
        const settle = state["settle"] as Settle | undefined;
        delete state["settle"];
        settle?.({
          outcome: result.outcome === "succeeded" ? "ok" : "error",
          ...(result.source === undefined ? {} : { attributes: { source: result.source } }),
        });
      }
      return Promise.resolve();
    },
  };
};

type Plan = { readonly sql?: string };
type MiddlewareContext = {
  readonly scope?: "runtime" | "connection" | "transaction";
  readonly state: (key: string | symbol) => Record<string | symbol, unknown>;
};
type Settled =
  | {
      readonly kind: "statement";
      readonly outcome: "succeeded" | "failed" | "stopped";
      readonly source?: string;
    }
  | { readonly kind: "transaction" };
