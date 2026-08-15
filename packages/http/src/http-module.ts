import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyProvider,
  type Available,
  type ErrOf,
  type ErrOfModule,
  type Exportable,
  type NeedOf,
  type NeedsOfModule,
  type Provider,
  type ResolvedExports,
  type ServiceOf,
} from "@btravstack/di";
import type { Router } from "@orpc/server";

import { HttpRuntime, http, type HttpConfig } from "./http-runtime.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter<RouterInstance> = Module<
  HttpRuntime | HttpConfig,
  ConfigInvalid,
  Env | RouterInstance
>;

/**
 * `unknown` when the provider's port carries a router `RPCHandler` can serve
 * with no initial context, `never` otherwise — intersected with the provider
 * at the call site, so a provider of anything else fails to typecheck there.
 */
type RouterProvider<RouterInstance> =
  ServiceOf<RouterInstance> extends Router<Record<never, never>> ? unknown : never;

export type HttpModuleOptions<
  RouterInstance,
  RouterError,
  RouterNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    [...I, HttpStarter<RouterInstance>],
    [Provider<RouterInstance, RouterError, RouterNeeds>, ...P]
  >[],
> = {
  /** The application's oRPC router, as the provider that builds it from the services its procedures call. */
  readonly router: Provider<RouterInstance, RouterError, RouterNeeds> &
    RouterProvider<RouterInstance>;
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
    RouterInstance,
    RouterError,
    RouterNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      [...I, HttpStarter<RouterInstance>],
      [Provider<RouterInstance, RouterError, RouterNeeds>, ...P]
    >[] = [],
  >(
    options: HttpModuleOptions<RouterInstance, RouterError, RouterNeeds, I, P, X>,
  ): Module<
    ResolvedExports<[typeof HttpRuntime, ...X]>,
    | ErrOf<[Provider<RouterInstance, RouterError, RouterNeeds>, ...P][number]>
    | ErrOfModule<[...I, HttpStarter<RouterInstance>][number]>,
    Exclude<
      | NeedOf<[Provider<RouterInstance, RouterError, RouterNeeds>, ...P][number]>
      | NeedsOfModule<[...I, HttpStarter<RouterInstance>][number]>,
      Available<
        [...I, HttpStarter<RouterInstance>],
        [Provider<RouterInstance, RouterError, RouterNeeds>, ...P]
      >
    >
  > => {
    const { router, prefix, port, hostname, imports = [], provides = [], exports = [] } = options;
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
    // The typing above is the whole contract; the value is the plain module
    // it describes. `never` because di computes the declared type from the
    // literal it is handed, and generic `I`/`P`/`X` are not one.
    return Module(name)({
      imports: [...imports, starter],
      provides: [router, ...provides],
      exports: [HttpRuntime, ...exports],
    } as never) as never;
  };
