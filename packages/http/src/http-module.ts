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

import type { AuthenticatorPort } from "./auth.js";
import { HttpRuntime, http, type HttpConfig } from "./http-runtime.js";
import type { HttpRouterPort } from "./orpc.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type HttpStarter = Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[]> = readonly [...I, HttpStarter];

/**
 * The router provider, the authenticator when there is one, and the
 * application's own — the tuple `Module(name)` is handed. `Auth` is inferred
 * from the option, so an omitted authenticator contributes no element and the
 * marked router's need for one stays unmet: di's gate, at `start`.
 */
type Provides<
  P extends readonly AnyProvider[],
  RouterError,
  RouterNeeds,
  Auth extends AnyProvider | undefined,
> = readonly [
  Provider<HttpRouterPort, RouterError, RouterNeeds>,
  ...([Auth] extends [undefined] ? [] : [NonNullable<Auth>]),
  ...P,
];

export type HttpModuleOptions<
  RouterError,
  RouterNeeds,
  RouterIdentity,
  Auth extends AnyProvider | undefined,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>>[],
  N extends readonly AnyPort[],
> = {
  /** The application's oRPC router — `HttpRouter(contract)(deps, arm)`, the provider that builds it from the services its procedures call. */
  readonly router: Provider<HttpRouterPort, RouterError, RouterNeeds> & {
    readonly identity: RouterIdentity;
  };
  /**
   * Resolves the principal a marked procedure's handler receives —
   * `HttpAuthenticator<Identity>()({ name: Dep }, { sync })`. Required exactly when
   * the router's contract marks something: a marked router declares
   * `AuthenticatorPort` as a need, and di refuses a graph that does not
   * discharge it. Whether it resolves what the handlers actually read is the
   * one thing that need cannot say — the port's service type is erased — so
   * `RouterIdentity`, read off `router`, is what checks it here: the
   * authenticator must resolve **at least** the identity the router was minted
   * with, so a router from `httpAuth<A>()` refuses an authenticator from
   * `httpAuth<B>()`. A router minted by the top-level `HttpRouter` carries no
   * identity (`never`), and there is then nothing to compare.
   */
  readonly authenticator?: Auth;
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
  /** Pins for a test — otherwise `PORT`/`HOST` from the environment. */
  readonly port?: number;
  readonly hostname?: string;
  /**
   * oRPC handler plugins — CORS, body limits, compression, CSRF. Transport
   * policy configuring the transport; this is NOT a middleware slot for
   * application logic, which the package still declines.
   */
  readonly plugins?: readonly NodeHttpHandlerPlugin<DefaultInitialContext>[];
  /**
   * Headers set on every response, before dispatch — a listener concern, not
   * oRPC's. `true` (default) applies the package's small helmet-style
   * default set; `false` disables it; a record replaces it outright.
   */
  readonly securityHeaders?: boolean | Readonly<Record<string, string>>;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `HttpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
  /**
   * What this root expects from outside — `Env` at least, since the starter
   * binds `PORT`/`HOST` from it and `start` is what provides it. Declared
   * here rather than absorbed: di's own gate is re-stated over the augmented
   * tuples below, so forgetting one is an error at THIS call, the same as it
   * would be on a bare `Module(name)`.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>, N>;

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
    RouterIdentity,
    const Auth extends
      | (Provider<AuthenticatorPort, never, unknown> & {
          readonly principal: [RouterIdentity] extends [never] ? unknown : RouterIdentity;
        })
      | undefined = undefined,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>>[] =
      [],
    const N extends readonly AnyPort[] = [],
  >(
    options: HttpModuleOptions<RouterError, RouterNeeds, RouterIdentity, Auth, I, P, X, N>,
  ) => {
    const { router, authenticator, prefix, port, hostname, plugins, securityHeaders } = options;
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
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    //
    // The assertion is the gate, not the shape: `NeedsGate` cannot be computed
    // while the tuples are still type parameters, so it defers and no object
    // literal satisfies it here. It IS computed at the application's own call,
    // because the sugar re-declares it on `HttpModuleOptions`. Asserting to a
    // spelled-out type rather than `as never` is what keeps `I`/`P`/`X`/`N`
    // inferred — `as never` collapses the return type to
    // `Module<never, never, never>` (measured).
    return Module(name)({
      imports: [...imports, starter] as Imports<I>,
      provides: [
        router,
        ...(authenticator === undefined ? [] : [authenticator]),
        ...provides,
      ] as unknown as Provides<P, RouterError, RouterNeeds, Auth>,
      exports: [HttpRuntime, ...exports] as readonly [typeof HttpRuntime, ...X],
      needs: (options.needs ?? []) as N,
    } as {
      readonly imports: Imports<I>;
      readonly provides: Provides<P, RouterError, RouterNeeds, Auth>;
      readonly exports: readonly [typeof HttpRuntime, ...X];
      readonly needs: N;
    } & NeedsGate<Imports<I>, Provides<P, RouterError, RouterNeeds, Auth>, N>);
  };
