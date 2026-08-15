import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyProvider,
  type Exportable,
  type PortInstance,
  type Provider,
} from "@btravstack/di";
import type { Router } from "@orpc/server";

import { HttpRuntime, http, type HttpConfig } from "./http-runtime.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter<RouterInstance> = Module<
  HttpRuntime | HttpConfig,
  ConfigInvalid,
  Env | RouterInstance
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[], RouterInstance> = readonly [
  ...I,
  HttpStarter<RouterInstance>,
];

/** The router provider plus the application's own — the tuple `Module(name)` is handed. */
type Provides<
  P extends readonly AnyProvider[],
  RouterInstance,
  RouterError,
  RouterNeeds,
> = readonly [Provider<RouterInstance, RouterError, RouterNeeds>, ...P];

/** A router port's instance: its service is a context-free oRPC router — the one shape `http()` serves. */
type AnyRouterInstance = PortInstance<string, Router<Record<never, never>>>;

export type HttpModuleOptions<
  RouterInstance extends AnyRouterInstance,
  RouterError,
  RouterNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    Imports<I, RouterInstance>,
    Provides<P, RouterInstance, RouterError, RouterNeeds>
  >[],
> = {
  /** The application's oRPC router, as the provider that builds it from the services its procedures call. */
  readonly router: Provider<RouterInstance, RouterError, RouterNeeds>;
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
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
 * starter (`http({ router })`), provides the router, and exports
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
 *   imports: [ApplicationModule, PersistenceModule],
 *   exports: [Logger],
 * });
 * await runMain(OrderApi);
 * ```
 */
export const HttpModule =
  <const Name extends string>(name: Name) =>
  <
    RouterInstance extends AnyRouterInstance,
    RouterError,
    RouterNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      Imports<I, RouterInstance>,
      Provides<P, RouterInstance, RouterError, RouterNeeds>
    >[] = [],
  >(
    options: HttpModuleOptions<RouterInstance, RouterError, RouterNeeds, I, P, X>,
  ) => {
    const { router, prefix, port, hostname } = options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    // `router.port` is the port class the provider targets — `AnyPort` at
    // this level; the constraint that its service is a context-free router
    // was checked on the provider's instance type above, so `http()`'s
    // class-level check has nothing left to add.
    const starter = http({
      router: router.port as never,
      ...(prefix === undefined ? {} : { prefix }),
      ...(port === undefined ? {} : { port }),
      ...(hostname === undefined ? {} : { hostname }),
    });
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    return Module(name)({
      imports: [...imports, starter as HttpStarter<RouterInstance>] as Imports<I, RouterInstance>,
      provides: [router, ...provides] as Provides<P, RouterInstance, RouterError, RouterNeeds>,
      exports: [HttpRuntime, ...exports] as readonly [typeof HttpRuntime, ...X],
    });
  };
