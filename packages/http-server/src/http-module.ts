import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyPort,
  type AnyProvider,
  type Exportable,
  type NeedsGate,
  type PortInstance,
  type Provider,
} from "@btravstack/di";

import { HttpHandler } from "./handler.js";
import type { HtmxFragmentsPort } from "./htmx-route.js";
import { htmx } from "./htmx.js";
import type { HttpConfig } from "./http-config.js";
import {
  HttpRuntime,
  httpServer,
  type AnyUnitModule,
  type HttpOptions,
  type HttpUnit,
  type UnitsNeedsOf,
} from "./http-runtime.js";
import { orpc, type OrpcRouterPort } from "./orpc.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter<Units> = Module<
  HttpRuntime | HttpConfig | HttpHandler | HttpUnit,
  ConfigInvalid,
  Env | UnitsNeedsOf<Units>
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[], Units> = readonly [...I, HttpStarter<Units>];

/** Whatever `api.OrpcRouter(contract)(…)` returns. */
type AnyRouterProvider = Provider<OrpcRouterPort, unknown, unknown> & {
  readonly authenticators: readonly AnyProvider[];
};

/** Whatever `api.HtmxFragments([…])` returns. */
type AnyFragmentsProvider = Provider<HtmxFragmentsPort, unknown, unknown> & {
  readonly authenticators: readonly AnyProvider[];
};

/** The scheme authenticators a supplied provider carries, or `never` when none was supplied. */
type AuthOf<T> = T extends { readonly authenticators: readonly (infer A)[] } ? A : never;

/** The `orpc()`/`htmx()` answerer this root composes when the matching option is supplied. */
type OrpcAnswerer = ReturnType<typeof orpc>;
type HtmxAnswerer = ReturnType<typeof htmx>;

/**
 * What this root provides: the router and its own `orpc()` answerer when
 * `router` is supplied, the fragments provider and its own `htmx()` answerer
 * when `fragments` is, each provider's scheme authenticators, and the
 * application's own. `Router`/`Fragments` resolve to `undefined` — every
 * branch gated on them collapsing to `never` — when the matching option is
 * omitted, which is what lets `HttpModule` compose a router, fragments, or
 * both from one declaration. A union-element array rather than a tuple:
 * each authenticator union is one type per scheme, and a tuple takes one
 * rest element, not two.
 */
type Provides<P extends readonly AnyProvider[], Router, Fragments> = readonly (
  | ([Router] extends [undefined] ? never : Exclude<Router, undefined> | OrpcAnswerer)
  | ([Fragments] extends [undefined] ? never : Exclude<Fragments, undefined> | HtmxAnswerer)
  | AuthOf<Router>
  | AuthOf<Fragments>
  | P[number]
)[];

/**
 * The kinds `units<…>()` declared, read back off the router's `_units` phantom.
 * A provider carrying no such property infers `unknown`, and a router `units`
 * was never called on carries the empty record — both give no keys, which is
 * what the gate below reads as "this api declared none".
 */
type UnitsOfRouter<R> = R extends { readonly _units?: infer U } ? U : Record<never, never>;

/**
 * Every scheme a supplied answerer serves. Recovered from its needs channel
 * rather than from a phantom of its own: a router already owes one
 * `HttpAuthenticator:${scheme}` port per scheme its contract marks, and a
 * fragments provider one per scheme its routes require, so the names are
 * already there to be read.
 */
type SchemesOfAnswerer<T> = T extends { readonly _needs: () => infer N }
  ? N extends PortInstance<`HttpAuthenticator:${infer S}`, unknown>
    ? S
    : never
  : never;

/**
 * The kinds this root may bind: the ones `units<…>()` declared when the router
 * carries them, else `anonymous` and every scheme the answerers serve. An
 * unbound scheme falls back to `anonymous` at runtime, so without this a
 * misspelled kind would fork `anonymous` for every request and diagnose
 * nothing.
 */
type BindableKinds<Router, Fragments> = [keyof UnitsOfRouter<Router>] extends [never]
  ? "anonymous" | SchemesOfAnswerer<Router> | SchemesOfAnswerer<Fragments>
  : keyof UnitsOfRouter<Router>;

/**
 * A bound kind no request can ever open under. A record whose keys are not
 * literal — one built by `Object.fromEntries` — carries no name to check, so it
 * is passed rather than refused for having a `string` key outside the set.
 */
type UndeclaredKind<Units, Router, Fragments> = string extends keyof Units
  ? never
  : Exclude<keyof Units, BindableKinds<Router, Fragments>>;

/**
 * The `unit` gate, riding an intersection on the option so `Units` still infers
 * from the value. An undeclared kind is refused against a marker — an
 * excess-property check cannot see one, since the key is part of the very type
 * it inferred. A declared kind bound to the wrong module is refused by ordinary
 * assignability against the module type `units<…>()` named, which is the
 * diagnostic worth having.
 */
type UnitGate<Units, Router, Fragments> = [UndeclaredKind<Units, Router, Fragments>] extends [never]
  ? {
      readonly [K in keyof Units & keyof UnitsOfRouter<Router>]: UnitsOfRouter<Router>[K];
    }
  : {
      readonly "UNDECLARED UNIT KIND — no request opens under it, so it would silently fall back to anonymous": UndeclaredKind<
        Units,
        Router,
        Fragments
      >;
    };

/**
 * The "serves nothing" gate: `unknown` once at least one of `router` /
 * `fragments` is supplied, an object with one required property when
 * neither is — `NeedsGate`'s own construction, so a root declaring no
 * answerer at all is refused at the call rather than booting a listener with
 * nothing behind it.
 */
type ServesNothingGate<Router, Fragments> = [Router] extends [undefined]
  ? [Fragments] extends [undefined]
    ? { readonly "SERVES NOTHING — supply a router, fragments, or both": true }
    : unknown
  : unknown;

export type HttpModuleOptions<
  Router extends AnyRouterProvider | undefined,
  Fragments extends AnyFragmentsProvider | undefined,
  Units extends Readonly<Record<string, AnyUnitModule>> | undefined,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I, Units>, Provides<P, Router, Fragments>>[],
  N extends readonly AnyPort[],
> = Omit<HttpOptions, "unit"> & {
  /**
   * The unit module each KIND binds — `anonymous` for a request no leaf asked
   * to authenticate, else the scheme that resolved the caller. Every bound
   * module's own unmet needs join this root's, less the principal the fork
   * seeds: a composition that binds one owes the composition root the same way
   * any other `needs` does.
   *
   * The kinds are gated against the router: the ones `units<…>()` declared, or
   * — for a plain `defineHttp()` api — `anonymous` and every scheme the
   * answerers serve.
   */
  readonly unit?: Units & UnitGate<Units, Router, Fragments>;
  /**
   * The application's oRPC router — what `api.OrpcRouter(contract)(…)` returns.
   * It carries the scheme authenticators `defineHttp` bound, which is how they
   * reach `provides` without an application listing them. Optional: a root may
   * serve `fragments` alone.
   */
  readonly router?: Router;
  /**
   * The application's htmx fragments — what `api.HtmxFragments([…])`
   * returns. Carries its own scheme authenticators the same way `router` does.
   * Optional: a root may serve `router` alone. An authenticator provider the
   * two share is deduplicated by reference before it reaches `provides`, so
   * this module's own array is correct on its own terms rather than relying
   * on di's internal module-tree flattening to absorb the duplicate.
   */
  readonly fragments?: Fragments;
  /**
   * Where htmx fragments are mounted, default `/` — `htmx()`'s own default.
   * `prefix` (above, from `HttpOptions`) stays the oRPC mount, default `/rpc`:
   * one field cannot carry two independent mount points with two different
   * defaults, so a root serving both protocols gets this second,
   * differently-named option instead of overloading the first.
   */
  readonly fragmentsPrefix?: `/${string}`;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `HttpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
  /**
   * What this root's OWN providers expect from outside. di's gate is re-stated
   * over the augmented tuples below, so forgetting one is an error at THIS call.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I, Units>, Provides<P, Router, Fragments>, N> &
  ServesNothingGate<Router, Fragments>;

/**
 * `Module(name)({...})` for an HTTP deployment: everything a di module takes,
 * plus a router, fragments, or both. The sugar imports the socket half
 * (`httpServer`), provides whichever answerer(s) the options name and exports
 * `HttpRuntime`, handing back exactly the module `Module(...)` would have
 * declared over the augmented tuples.
 *
 * ```ts
 * export const OrderApi = HttpModule("OrderApi")({
 *   router: orderRouter,
 *   imports: [OrderApplicationModule, OrderPersistenceModule],
 *   exports: [Logger],
 * });
 * await runMain(OrderApi);
 * ```
 *
 * A fragments-only root drops `router` and supplies `fragments` instead; a
 * root serving both supplies both, and `prefix`/`fragmentsPrefix` mount them
 * independently. Supplying neither is refused at this call.
 */
export const HttpModule =
  <const Name extends string>(name: Name) =>
  <
    Router extends AnyRouterProvider | undefined = undefined,
    Fragments extends AnyFragmentsProvider | undefined = undefined,
    Units extends Readonly<Record<string, AnyUnitModule>> | undefined = undefined,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I, Units>, Provides<P, Router, Fragments>>[] = [],
    const N extends readonly AnyPort[] = [],
  >(
    options: HttpModuleOptions<Router, Fragments, Units, I, P, X, N>,
  ) => {
    const { router, fragments } = options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    // The whole options record, not a field-by-field spread: `HttpModuleOptions`
    // IS `HttpOptions` plus the module lists, so an option this sugar forgets
    // to forward cannot exist — which is the drift this file shipped once. The
    // lists `httpServer`/`orpc`/`htmx` do not know are ignored rather than
    // rejected, a rest destructuring being what `exactOptionalPropertyTypes`
    // cannot type here (`Omit` over the deferred `NeedsGate` intersection drops
    // the modifiers).
    const starter = httpServer(options);
    // Keyed by reference, the same technique di's own module-tree flattening
    // uses: the SAME authenticator provider named by both `router` and
    // `fragments` lands in `provides` once, so this array is correct on its
    // own terms rather than by relying on di to absorb the duplicate.
    const authenticators = [
      ...new Set([...(router?.authenticators ?? []), ...(fragments?.authenticators ?? [])]),
    ];
    // The assertion is the gate, not the shape: `NeedsGate` defers while the
    // tuples are type parameters, and is computed at the application's own call
    // because `HttpModuleOptions` re-declares it. Spelled out rather than
    // `as never`, which collapses the return to `Module<never, never, never>`.
    return Module(name)({
      imports: [...imports, starter] as Imports<I, Units>,
      provides: [
        ...(router === undefined ? [] : [router, orpc(options)]),
        ...(fragments === undefined
          ? []
          : [
              fragments,
              htmx(
                options.fragmentsPrefix === undefined ? {} : { prefix: options.fragmentsPrefix },
              ),
            ]),
        ...authenticators,
        ...provides,
      ] as unknown as Provides<P, Router, Fragments>,
      // `HttpHandler` too, and not as a courtesy: the runtime RESOLVES it, so
      // `start`'s gate refuses a root that does not export it. A second
      // protocol's answerer lands in the same set from its own provider.
      exports: [HttpRuntime, HttpHandler, ...exports] as readonly [
        typeof HttpRuntime,
        typeof HttpHandler,
        ...X,
      ],
      needs: (options.needs ?? []) as N,
    } as {
      readonly imports: Imports<I, Units>;
      readonly provides: Provides<P, Router, Fragments>;
      readonly exports: readonly [typeof HttpRuntime, typeof HttpHandler, ...X];
      readonly needs: N;
    } & NeedsGate<Imports<I, Units>, Provides<P, Router, Fragments>, N>);
  };
