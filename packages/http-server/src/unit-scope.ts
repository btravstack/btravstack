import type { UnitHost } from "@btravstack/core";
import type { AnyPort, Context } from "@btravstack/di";
import { OkAsync, type AsyncResult } from "unthrown";

import type { Resolved } from "./auth.js";
import type { AnyUnitModule } from "./http-runtime.js";
import { unitRecordOf } from "./unit.js";

/**
 * Forks the unit's scope for a request an answerer is about to handle, and
 * answers the declared `unit:` record over it. Shared by both answerers —
 * `unitScope` below is oRPC's fork, `htmx.ts`'s is the fragments' — so the
 * kind, the seed and the record cannot drift between them.
 *
 * The kind is the scheme that resolved, falling back to `anonymous`: a scheme
 * that binds no module of its own is how one KIND is specialised, not how the
 * others are switched off. Nothing is forked only when neither binds one, and
 * that is an empty record rather than an absent one — `UnitFor` hides every
 * name in that case, so a handler has nothing to read anyway.
 *
 * The seed is the principal on the port its own scheme minted, which is what
 * discharges a unit module's `needs: [auth.principals.user]` without the
 * composition root providing one. It is keyed on whether a scheme RESOLVED,
 * never on which module ends up forked: a seed the forked module never names
 * costs one unread entry.
 */
export const forkUnit = (
  host: UnitHost<never>,
  units: Readonly<Record<string, AnyUnitModule>>,
  principals: Readonly<Record<string, AnyPort>>,
  resolved: Resolved | undefined,
  record: Readonly<Record<string, AnyPort>>,
): AsyncResult<Readonly<Record<string, unknown>>, never> => {
  const module = units[resolved?.scheme ?? "anonymous"] ?? units["anonymous"];
  if (module === undefined) return OkAsync({});
  // Asserted, not guarded, on the same grounds `auth.ts`'s authenticator
  // lookup is: `defineHttp` mints one principal port per declared scheme, and
  // only a declared scheme can have resolved.
  const seed = resolved === undefined ? [] : [[principals[resolved.scheme], resolved.identity]];
  // `as never` on both arguments: `AnyUnitModule` erases a module's Needs to
  // `unknown` — the only bound a module with real needs can infer against — so
  // `fork`'s own `DependencyGate` sees `Exclude<unknown, Scope>`, still
  // `unknown`, and never clears on its own; and `fork` infers its `Seeded` port
  // from the seed, which is keyed by a runtime scheme name rather than by a
  // literal type. The needs were already checked once, at the `Units`-generic
  // call site that bound this module (`httpServer`'s own type parameter, proven
  // by `http-module.test-d.ts`'s positive/negative pair) — this reasserts that
  // proof rather than bypassing it.
  return host
    .fork(module as never, seed as never)
    .map((forked) => unitRecordOf(forked as Context<never>, record));
};

/**
 * oRPC's fork: installed on every leaf, after `principalMiddleware` where there
 * is one, so the scheme that authenticated the caller is what decides the kind.
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
  }): Promise<unknown> =>
    // `.get()` on an `AsyncResult<T, never>` rethrows a defect's own cause,
    // which is how it reaches oRPC — the middleware protocol has no returned-
    // error arm of its own.
    await options.next({
      context: {
        unit: await forkUnit(
          options.context.host,
          units,
          principals,
          options.context.resolved,
          record,
        ).get(),
      },
    });
