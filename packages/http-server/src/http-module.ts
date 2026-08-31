import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyPort,
  type AnyProvider,
  type Exportable,
  type NeedsGate,
  type Provider,
} from "@btravstack/di";

import { HttpHandler } from "./handler.js";
import type { HtmxFragmentsPort } from "./htmx-route.js";
import { htmx } from "./htmx.js";
import type { HttpConfig } from "./http-config.js";
import { HttpRuntime, httpServer, type HttpOptions } from "./http-runtime.js";
import { orpc, type HttpRouterPort } from "./orpc.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter = Module<HttpRuntime | HttpConfig | HttpHandler, ConfigInvalid, Env>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[]> = readonly [...I, HttpStarter];

/** Whatever `api.HttpRouter(contract)(…)` returns. */
type AnyRouterProvider = Provider<HttpRouterPort, unknown, unknown> & {
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
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I>, Provides<P, Router, Fragments>>[],
  N extends readonly AnyPort[],
> = HttpOptions & {
  /**
   * The application's oRPC router — what `api.HttpRouter(contract)(…)` returns.
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
} & NeedsGate<Imports<I>, Provides<P, Router, Fragments>, N> &
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
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I>, Provides<P, Router, Fragments>>[] = [],
    const N extends readonly AnyPort[] = [],
  >(
    options: HttpModuleOptions<Router, Fragments, I, P, X, N>,
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
      imports: [...imports, starter] as Imports<I>,
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
      readonly imports: Imports<I>;
      readonly provides: Provides<P, Router, Fragments>;
      readonly exports: readonly [typeof HttpRuntime, typeof HttpHandler, ...X];
      readonly needs: N;
    } & NeedsGate<Imports<I>, Provides<P, Router, Fragments>, N>);
  };
