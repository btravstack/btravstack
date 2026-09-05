import type { UnitHost } from "@btravstack/core";
import type { Context } from "@btravstack/di";

import type { AnyUnitModule } from "./http-runtime.js";

/**
 * Forks the unit's scope for the request oRPC is about to handle, and puts
 * the forked context on the procedure's context as `unit`. Installed on every
 * leaf, after `principalMiddleware` where there is one, so a later phase can
 * seed it with what the principal resolved to.
 */
export const unitScope =
  (module: AnyUnitModule | undefined) =>
  async (options: {
    readonly context: { readonly host: UnitHost<never> };
    readonly next: (injected: {
      readonly context: { readonly unit: Context<never> | undefined };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    if (module === undefined) return await options.next({ context: { unit: undefined } });
    // `.get()` on an `AsyncResult<T, never>` rethrows a defect's own cause,
    // which is how it reaches oRPC — the middleware protocol has no returned-
    // error arm of its own.
    //
    // `as never`: `AnyUnitModule` erases a module's Needs to `unknown` — the
    // only bound a module with real needs can infer against — so `fork`'s own
    // `DependencyGate` sees `Exclude<unknown, Scope>`, still `unknown`, and
    // never clears on its own. The needs were already checked once, at the
    // `Unit`-generic call site that bound this module (`httpServer`'s own
    // type parameter, proven by `http-module.test-d.ts`'s positive/negative
    // pair) — this reasserts that proof rather than bypassing it.
    const unit = await options.context.host.fork(module as never, []).get();
    return await options.next({ context: { unit: unit as Context<never> } });
  };
