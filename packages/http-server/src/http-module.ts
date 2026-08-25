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
import type { DefaultInitialContext } from "@orpc/server";
import type { NodeHttpHandlerPlugin } from "@orpc/server/node";

import { HttpRuntime, http, type HttpConfig } from "./http-runtime.js";
import type { HttpRouterPort } from "./orpc.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter = Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[]> = readonly [...I, HttpStarter];

/**
 * The router provider, the scheme authenticators `defineHttp` bound, and the
 * application's own. A union-element array rather than a tuple: `Auth` is one
 * type per scheme, and a tuple takes one rest element, not two. Putting the
 * authenticators here is what carries their own needs into `NeedsGate`.
 */
type Provides<
  P extends readonly AnyProvider[],
  RouterError,
  RouterNeeds,
  Auth extends AnyProvider,
> = readonly (Provider<HttpRouterPort, RouterError, RouterNeeds> | Auth | P[number])[];

export type HttpModuleOptions<
  RouterError,
  RouterNeeds,
  Auth extends AnyProvider,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>>[],
  N extends readonly AnyPort[],
> = {
  /**
   * The application's oRPC router — what `api.HttpRouter(contract)(…)` returns.
   * It carries the scheme authenticators `defineHttp` bound, which is how they
   * reach `provides` without an application listing them.
   */
  readonly router: Provider<HttpRouterPort, RouterError, RouterNeeds> & {
    readonly authenticators: readonly Auth[];
  };
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
  /** Pins for a test — otherwise `PORT`/`HOST` from the environment. */
  readonly port?: number;
  readonly hostname?: string;
  /**
   * oRPC handler plugins — CORS, body limits, compression, CSRF. Transport
   * policy configuring the transport; not a middleware slot for application
   * logic, which the package still declines.
   */
  readonly plugins?: readonly NodeHttpHandlerPlugin<DefaultInitialContext>[];
  /**
   * Headers set on every response, before dispatch — a listener concern, not
   * oRPC's. `true` (default) applies the package's small helmet-style set;
   * `false` disables it; a record replaces it outright.
   */
  readonly securityHeaders?: boolean | Readonly<Record<string, string>>;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `HttpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
  /**
   * What this root's OWN providers expect from outside. di's gate is re-stated
   * over the augmented tuples below, so forgetting one is an error at THIS call.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>, N>;

/**
 * `Module(name)({...})` for an HTTP deployment: everything a di module takes,
 * plus the router provider. The sugar imports the starter, provides the router
 * and exports `HttpRuntime`, handing back exactly the module `Module(...)` would
 * have declared over the augmented tuples.
 *
 * ```ts
 * export const OrderApi = HttpModule("OrderApi")({
 *   router: orderRouter,
 *   imports: [OrderApplicationModule, OrderPersistenceModule],
 *   exports: [Logger],
 * });
 * await runMain(OrderApi);
 * ```
 */
export const HttpModule =
  <const Name extends string>(name: Name) =>
  <
    RouterError,
    RouterNeeds,
    Auth extends AnyProvider = never,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>>[] =
      [],
    const N extends readonly AnyPort[] = [],
  >(
    options: HttpModuleOptions<RouterError, RouterNeeds, Auth, I, P, X, N>,
  ) => {
    const { router, prefix, port, hostname, plugins, securityHeaders } = options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    const starter = http({
      ...(prefix === undefined ? {} : { prefix }),
      ...(port === undefined ? {} : { port }),
      ...(hostname === undefined ? {} : { hostname }),
      ...(plugins === undefined ? {} : { plugins }),
      ...(securityHeaders === undefined ? {} : { securityHeaders }),
    });
    // The assertion is the gate, not the shape: `NeedsGate` defers while the
    // tuples are type parameters, and is computed at the application's own call
    // because `HttpModuleOptions` re-declares it. Spelled out rather than
    // `as never`, which collapses the return to `Module<never, never, never>`.
    return Module(name)({
      imports: [...imports, starter] as Imports<I>,
      provides: [router, ...router.authenticators, ...provides] as unknown as Provides<
        P,
        RouterError,
        RouterNeeds,
        Auth
      >,
      exports: [HttpRuntime, ...exports] as readonly [typeof HttpRuntime, ...X],
      needs: (options.needs ?? []) as N,
    } as {
      readonly imports: Imports<I>;
      readonly provides: Provides<P, RouterError, RouterNeeds, Auth>;
      readonly exports: readonly [typeof HttpRuntime, ...X];
      readonly needs: N;
    } & NeedsGate<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>, N>);
  };
