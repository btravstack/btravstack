import type { UnitHost } from "@btravstack/core";
import type { AnyPort, Context } from "@btravstack/di";

import type { Resolved } from "./auth.js";
import type { AnyUnitModule } from "./http-runtime.js";
import { unitRecordOf } from "./unit.js";

/**
 * The principal the fork is seeded with, on the port its own scheme minted —
 * which is what discharges a unit module's `needs: [auth.principals.user]`
 * without the composition root providing one. Keyed on whether a scheme
 * RESOLVED, never on which module ends up forked: a seed the forked module
 * never names costs one unread entry. A request no leaf authenticated is
 * seeded with nothing, since there is no caller to name. Shared by both
 * answerers: `unitScope` below is oRPC's fork, `htmx.ts`'s `respond` is the
 * fragments' one, and this is the seed they agree on.
 */
export const seedOf = (
  principals: Readonly<Record<string, AnyPort>>,
  resolved: Resolved | undefined,
): readonly (readonly [AnyPort, unknown])[] =>
  resolved === undefined
    ? []
    : // Asserted, not guarded, on the same grounds `auth.ts`'s authenticator
      // lookup is: `defineHttp` mints one principal port per declared scheme,
      // and only a declared scheme can have resolved.
      [[principals[resolved.scheme] as AnyPort, resolved.identity]];

/**
 * Forks the unit's scope for the request oRPC is about to handle, and puts the
 * forked context on the procedure's context as `unit`. Installed on every leaf,
 * after `principalMiddleware` where there is one, so the scheme that
 * authenticated the caller is what decides the kind.
 *
 * A scheme that binds no module of its own falls back to `anonymous`, so
 * binding only `anonymous` keeps forking on every leaf; a scheme's module is
 * how one KIND is specialised, not how the others are switched off. Nothing is
 * forked only when neither the scheme nor `anonymous` binds one. `htmx.ts`
 * applies the same rule at its own fork site, over the same {@link seedOf}.
 */
export const unitScope =
  (
    units: Readonly<Record<string, AnyUnitModule>>,
    principals: Readonly<Record<string, AnyPort>>,
    record: Readonly<Record<string, AnyPort>>,
  ) =>
  async (options: {
    readonly context: { readonly host: UnitHost<never>; readonly resolved?: Resolved };
    readonly next: (injected: {
      readonly context: { readonly unit: Readonly<Record<string, unknown>> };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    const { resolved } = options.context;
    const module = units[resolved?.scheme ?? "anonymous"] ?? units["anonymous"];
    if (module === undefined) return await options.next({ context: { unit: {} } });
    // `.get()` on an `AsyncResult<T, never>` rethrows a defect's own cause,
    // which is how it reaches oRPC — the middleware protocol has no returned-
    // error arm of its own.
    //
    // `as never` on both arguments: `AnyUnitModule` erases a module's Needs to
    // `unknown` — the only bound a module with real needs can infer against —
    // so `fork`'s own `DependencyGate` sees `Exclude<unknown, Scope>`, still
    // `unknown`, and never clears on its own; and `fork` infers its `Seeded`
    // port from the seed, which is keyed by a runtime scheme name rather than
    // by a literal type. The needs were already checked once, at the
    // `Units`-generic call site that bound this module (`httpServer`'s own
    // type parameter, proven by `http-module.test-d.ts`'s positive/negative
    // pair) — this reasserts that proof rather than bypassing it.
    const forked = (await options.context.host
      .fork(module as never, seedOf(principals, resolved) as never)
      .get()) as Context<never>;
    return await options.next({ context: { unit: unitRecordOf(forked, record) } });
  };
