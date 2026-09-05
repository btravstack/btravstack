import type { UnitHost } from "@btravstack/core";
import type { AnyPort, Context } from "@btravstack/di";

import type { Resolved } from "./auth.js";
import type { AnyUnitModule } from "./http-runtime.js";

/**
 * The principal the fork is seeded with, on the port its own scheme minted —
 * which is what discharges a unit module's `needs: [auth.principals.user]`
 * without the composition root providing one. An anonymous unit is seeded with
 * nothing: there is no caller to name.
 *
 * `as never`: `fork` infers its `Seeded` port from the entry, and this record
 * is keyed by a runtime scheme name rather than by a literal type.
 */
export const seedOf = (
  principals: Readonly<Record<string, AnyPort>>,
  resolved: Resolved | undefined,
): never =>
  (resolved === undefined ? [] : [[principals[resolved.scheme], resolved.identity]]) as never;

/**
 * Forks the unit's scope for the request oRPC is about to handle, and puts the
 * forked context on the procedure's context as `unit`. Installed on every leaf,
 * after `principalMiddleware` where there is one, so the scheme that
 * authenticated the caller is what decides the kind.
 *
 * A kind with no bound module forks nothing, and does not fall back to
 * `anonymous`: a caller's request opening the anonymous scope is the confusion
 * the kinds exist to prevent.
 */
export const unitScope =
  (units: Readonly<Record<string, AnyUnitModule>>, principals: Readonly<Record<string, AnyPort>>) =>
  async (options: {
    readonly context: { readonly host: UnitHost<never>; readonly resolved?: Resolved };
    readonly next: (injected: {
      readonly context: { readonly unit: Context<never> | undefined };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    const { resolved } = options.context;
    const module = units[resolved?.scheme ?? "anonymous"];
    if (module === undefined) return await options.next({ context: { unit: undefined } });
    // `.get()` on an `AsyncResult<T, never>` rethrows a defect's own cause,
    // which is how it reaches oRPC — the middleware protocol has no returned-
    // error arm of its own.
    //
    // `as never`: `AnyUnitModule` erases a module's Needs to `unknown` — the
    // only bound a module with real needs can infer against — so `fork`'s own
    // `DependencyGate` sees `Exclude<unknown, Scope>`, still `unknown`, and
    // never clears on its own. The needs were already checked once, at the
    // `Units`-generic call site that bound this module (`httpServer`'s own
    // type parameter, proven by `http-module.test-d.ts`'s positive/negative
    // pair) — this reasserts that proof rather than bypassing it.
    const unit = await options.context.host
      .fork(module as never, seedOf(principals, resolved))
      .get();
    return await options.next({ context: { unit: unit as Context<never> } });
  };
