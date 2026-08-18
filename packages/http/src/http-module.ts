import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyProvider,
  type Exportable,
  type Provider,
} from "@btravstack/di";

import { HttpRuntime, http, type HttpConfig, type TenantOf } from "./http-runtime.js";
import type { HttpRouterPort } from "./orpc.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter = Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[]> = readonly [...I, HttpStarter];

/** The router provider plus the application's own — the tuple `Module(name)` is handed. */
type Provides<P extends readonly AnyProvider[], RouterError, RouterNeeds> = readonly [
  Provider<HttpRouterPort, RouterError, RouterNeeds>,
  ...P,
];

export type HttpModuleOptions<
  RouterError,
  RouterNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I>, Provides<P, RouterError, RouterNeeds>>[],
> = {
  /** The application's oRPC router — `HttpRouter(contract)(deps, arm)`, the provider that builds it from the services its procedures call. */
  readonly router: Provider<HttpRouterPort, RouterError, RouterNeeds>;
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
  /** See `HttpOptions.tenantOf`. */
  readonly tenantOf?: TenantOf;
  /** Pins for a test — otherwise `PORT`/`HOST` from the environment. */
  readonly port?: number;
  readonly hostname?: string;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `HttpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
};

/**
 * `Module(name)({...})` for an HTTP deployment: everything a di module takes,
 * plus the router provider, and nothing else to know. The sugar imports the
 * starter (`http()`), provides the router, and exports
 * `HttpRuntime` — so a root that would otherwise write those two lines and
 * remember that `start` needs the runtime exported writes neither. It hands
 * back exactly the module `Module(...)` would have declared over the
 * augmented `imports`/`provides`/`exports` (spelled from di's own pieces), so
 * the kernel, `start`'s gate and di's see nothing new: syntax over the same
 * primitives, one source of truth.
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
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I>, Provides<P, RouterError, RouterNeeds>>[] = [],
  >(
    options: HttpModuleOptions<RouterError, RouterNeeds, I, P, X>,
  ) => {
    const { router, prefix, port, hostname, tenantOf } = options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    const starter = http({
      ...(prefix === undefined ? {} : { prefix }),
      ...(tenantOf === undefined ? {} : { tenantOf }),
      ...(port === undefined ? {} : { port }),
      ...(hostname === undefined ? {} : { hostname }),
    });
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    return Module(name)({
      imports: [...imports, starter] as Imports<I>,
      provides: [router, ...provides] as Provides<P, RouterError, RouterNeeds>,
      exports: [HttpRuntime, ...exports] as readonly [typeof HttpRuntime, ...X],
    });
  };
