import {
  isAuthenticated,
  type Authenticated,
  type IsMarked,
  type PrincipalKey,
} from "@btravstack/contract";
import {
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import type { ProcedureContract, RouterContract } from "@orpc/contract";
import {
  implement,
  type DefaultInitialContext,
  type ProcedureImplementer,
  type Router,
} from "@orpc/server";
import { RPCHandler, type NodeHttpHandlerPlugin } from "@orpc/server/node";
import "@unthrown/orpc/extensions/result";

import {
  AuthenticatorPort,
  noAuthenticator,
  principalMiddleware,
  type AuthenticatorService,
} from "./auth.js";
import { HttpHandler } from "./handler.js";

export type OrpcOptions = {
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
  /**
   * oRPC handler plugins — CORS, body limits, compression, CSRF. Transport
   * policy configuring the transport; this is NOT a middleware slot for
   * application logic, which the package still declines.
   */
  readonly plugins?: readonly NodeHttpHandlerPlugin<DefaultInitialContext>[];
};

/**
 * The router's port — one id, the starter's own. A process serves one router
 * as it boots one runtime, so the port is framework-owned like `HttpConfig`
 * and `HttpRuntime`, and an application never names it: `HttpRouter(...)`
 * returns the provider that targets it, and `provider.port` is the class for
 * the rare caller who needs it (a hand-declared provider, a type test). Two
 * router providers in one graph are di's duplicate-provider defect at build,
 * which is the point. Spelled through di's `PortClassOf` / `PortInstance`
 * rather than a `class` so a consumer's declaration emit can name the
 * provider's type without this package exporting the port (TS4023 otherwise,
 * measured on `examples/order-api`). Exported from this file for the
 * package's own tests, not from `index.ts`.
 */
export const HttpRouterPort = Port("HttpRouter") as PortClassOf<
  "HttpRouter",
  Router<Record<never, never>>
>;
export type HttpRouterPort = PortInstance<"HttpRouter", Router<Record<never, never>>>;

/**
 * The oRPC starter: a provider of `@btravstack/http`'s `HttpHandler` built
 * from the **router port** — the application provides its router as a service
 * (a provider that declares the use cases its procedures call), and this
 * turns it into the HTTP surface through oRPC's own node adapter, mounted
 * under `prefix`. A request oRPC does not match resolves unwritten and the
 * runtime answers its `404`; a defect inside a procedure is oRPC's own
 * `INTERNAL_SERVER_ERROR` collapse. Nothing here maps a `Result` to a status —
 * that is the router's `.result()` triage, at the one place a domain error
 * becomes an `ORPCError`.
 */
export const orpc = (options: OrpcOptions = {}) => {
  const prefix = options.prefix ?? "/rpc";
  return Provider(HttpHandler)(
    { router: HttpRouterPort },
    {
      sync: ({ router }) => {
        const rpc = new RPCHandler(router, { plugins: [...(options.plugins ?? [])] });
        // The request rides oRPC's initial context so `principalMiddleware` can
        // read its headers; nothing else in this package reads it.
        return (request, response) =>
          rpc.handle(request, response, { prefix, context: { request } });
      },
    },
  );
};

/**
 * The router as a provider, **from the contract**:
 *
 * ```ts
 * const orderRouter = HttpRouter(orderContract)({ place: PlaceOrder, find: FindOrder }, {
 *   sync: ({ place, find }) => ({
 *     orders: {
 *       place: ({ errors }, input) => place.execute(input.id, input.quantity).map(view).mapErrCases(…),
 *       find: ({ errors }, input) => find.execute(input.id).map(view).mapErrCases(…),
 *     },
 *   }),
 * });
 * ```
 *
 * The contract already says which procedures exist, what each takes and
 * returns and which errors it declares — so an implementation is a record
 * shaped like the contract whose leaves are plain `Result`-returning
 * functions (`(helpers, input) => AsyncResult<Output, ORPCError>`, the
 * `.result()` handler `@unthrown/orpc` gives an implementer), typed by the
 * contract at the call: a typo'd key, a missing procedure, a wrong output are
 * compile errors here. `implement(contract)`, `os.…`, `.result(...)` and
 * `os.router(...)` are what this call does for you.
 *
 * The first call fixes the contract; the second is di's
 * `Provider(port)({ name: Dep }, { sync })` on the starter's own router port, with
 * one difference: `sync` returns the implementation record and the router is
 * built from it. There is no name to give — a process serves one router, so
 * the port is the starter's (`HttpRouterPort`), and the provider carries it
 * typed (`orderRouter.port`) for whoever else needs the class.
 *
 * The second call also takes a **keyed record of controllers** instead of
 * `(deps, { sync })` — one argument rather than two, which is what tells the
 * two apart, exactly as `Provider(port)(…)` discriminates its own: `HttpRouter(contract)({ orders: ordersController, users:
 * usersController })`, one `HttpController` per top-level contract key. Each
 * fragment is composed as-is rather than re-implemented, and every key of the
 * contract must be covered — a missing or extra key is a compile error.
 */
/** What every `HttpRouter` arm returns; only the needs channel `N` differs. */
type Built<Identity, N> = Provider<
  PortInstance<"HttpRouter", Router<Record<never, never>>>,
  never,
  N
> & {
  readonly port: PortClassOf<"HttpRouter", Router<Record<never, never>>>;
  readonly identity: Identity;
};

export const routerFor =
  <Identity>() =>
  <C extends Record<string, RouterContract>>(contract: C) => {
    // The implementer is walked untyped: `Implementation<C>` above is the
    // whole check — a key the contract does not declare is a compile error
    // there, and `routerOf` skips one anyway rather than reading `.result` off
    // `undefined` — and `implement(contract)`'s own type is a per-contract
    // intersection this generic body cannot index into.
    const os = implement(contract) as unknown as Record<string, unknown> & {
      readonly router: (record: Record<string, unknown>) => Router<Record<never, never>>;
    };

    function build<const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      options: {
        readonly sync: (services: {
          readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
        }) => Implementation<C, Identity>;
      },
    ): Built<
      Identity,
      InstanceType<D[keyof D]> | (HasMark<C> extends true ? AuthenticatorPort : never)
    >;
    function build(options: {
      readonly sync: () => Implementation<C, Identity>;
    }): Built<Identity, HasMark<C> extends true ? AuthenticatorPort : never>;
    function build<
      M extends {
        readonly [K in Exclude<keyof C, PrincipalKey>]: ControllerFor<
          Inherit<C[K], IsMarked<C>>,
          Identity
        >;
      },
    >(
      controllers: M & {
        readonly [K in Exclude<keyof M, Exclude<keyof C, PrincipalKey>>]: never;
      },
    ): Built<
      Identity,
      InstanceType<M[keyof M]["port"]> | (HasMark<C> extends true ? AuthenticatorPort : never)
    >;
    function build(depsOrControllers: unknown, options?: unknown): unknown {
      const guarded = hasMarked(contract);
      // The authenticator rides a NAMESPACED key on the deps record, for the
      // same reason `tapped`'s port id is namespaced: the other keys are the
      // caller's own names, and this one must not be able to collide with a
      // dependency somebody called `authenticator`.
      const own = (services: Record<string, unknown>): Record<string, unknown> => {
        const { [AUTHENTICATOR]: _authenticator, ...rest } = services;
        return rest;
      };
      const withAuthenticator = (deps: Record<string, AnyPort>): Record<string, AnyPort> =>
        guarded ? { ...deps, [AUTHENTICATOR]: AuthenticatorPort } : deps;
      const routerFrom = (
        implementation: Record<string, unknown>,
        services: Record<string, unknown>,
      ): Router<Record<never, never>> =>
        os.router(
          routerOf(
            os,
            implementation,
            contract,
            isAuthenticated(contract),
            guarded ? (services[AUTHENTICATOR] as AuthenticatorService<unknown>) : undefined,
          ),
        );

      // THREE forms, two arguments' worth of arity — so this is the one place
      // in the family that cannot discriminate on arity alone. `(deps, arm)`
      // is settled by arity as everywhere else; the two one-argument forms —
      // an arm, and a controllers record — are told apart by whether `sync`
      // holds a FUNCTION. That is total rather than a heuristic: this helper
      // accepts no arm but `sync`, and a contract free to declare a key called
      // `sync` would put a *controller* there, which is an object carrying a
      // `.port`, never a function.
      const arm = (first: unknown): { readonly sync: (s: never) => unknown } | undefined =>
        typeof (first as { readonly sync?: unknown }).sync === "function"
          ? (first as { readonly sync: (s: never) => unknown })
          : undefined;
      const armOnly = options === undefined ? arm(depsOrControllers) : undefined;
      if (options !== undefined || armOnly !== undefined) {
        const supplied = (options ?? armOnly) as {
          readonly sync: (s: Record<string, unknown>) => unknown;
        };
        const deps = armOnly === undefined ? (depsOrControllers as Record<string, AnyPort>) : {};
        const sync = (services: Record<string, unknown>): Router<Record<never, never>> => {
          const call = supplied.sync as (...args: readonly unknown[]) => unknown;
          // The arm-only form's `sync` is typed `() => …`, so it is handed
          // nothing — the same arity guarantee `Provider` makes a no-deps
          // factory, and the reason this cannot just always pass a record.
          const built = armOnly === undefined ? call(own(services)) : call();
          return routerFrom(built as Record<string, unknown>, services);
        };
        return Provider(HttpRouterPort)(withAuthenticator(deps), { sync } as never);
      }

      // The controllers record is keyed by contract key, and so is the services
      // record it becomes — so the implementation IS what the graph resolved,
      // with nothing to reassemble positionally.
      const controllers = depsOrControllers as Record<string, { readonly port: AnyPort }>;
      const sync = (services: Record<string, unknown>): Router<Record<never, never>> =>
        routerFrom(own(services), services);
      return Provider(HttpRouterPort)(
        withAuthenticator(
          Object.fromEntries(
            Object.entries(controllers).map(([key, controller]) => [key, controller.port]),
          ),
        ),
        { sync } as never,
      );
    }

    return build;
  };

/**
 * The router, with no server-side identity: a handler under a marked key sees
 * `principal: never`, so any read of it is a compile error. That is the
 * "use the factory" signal — `httpAuth<Identity>()` is what mints the form
 * whose handlers see the application's own principal.
 */
export const HttpRouter: ReturnType<typeof routerFor<never>> = routerFor<never>();

// Namespaced so it cannot collide with a key the caller wrote; see `build`.
const AUTHENTICATOR = "@btravstack/http/authenticator";

/** A controller for one fragment — what `HttpController` returns, as the keyed form consumes it. */
type ControllerFor<Fragment extends RouterContract, Identity = never> = {
  readonly port: PortClassOf<string, Implementation<Fragment, Identity>>;
};

/**
 * What `HttpRouter(contract)(…)(…, { sync })`'s `sync` returns: the contract's
 * shape, with a `Result`-returning handler at every procedure — the parameter
 * `@unthrown/orpc`'s `.result()` takes on that procedure's implementer, so
 * the input is the contract's parsed input, the output its declared output
 * and the `errors` helpers its declared error map.
 */
export type Implementation<C extends RouterContract, Identity = never> =
  C extends ProcedureContract<infer I, infer O, infer E>
    ? Parameters<
        ProcedureImplementer<
          DefaultInitialContext & object,
          ContextOf<C, Identity>,
          I,
          O,
          E
        >["result"]
      >[0]
    : {
        readonly [K in Exclude<keyof C, PrincipalKey>]: C[K] extends RouterContract
          ? Implementation<Inherit<C[K], IsMarked<C>>, Identity>
          : never;
      };

/**
 * What a leaf's handler gets on `opts.context`: the principal when the leaf is
 * marked, and `object` — today's spelling, unchanged — when it is not. It rides
 * oRPC's own context channel, injected into `ProcedureImplementer`'s second
 * type parameter, so this package adds no second handler parameter and wraps no
 * `.result()` handler.
 *
 * The contract says only **whether** a leaf is protected; `Identity` — from
 * `httpAuth<Identity>()` — says **what** the principal is. The top-level
 * `HttpRouter` / `HttpController` pass `never`, so a marked leaf reached
 * without the factory types `principal: never` and any read of it is a compile
 * error: the "use the factory" signal, rather than a principal invented from a
 * type the contract no longer carries.
 */
type ContextOf<C, Identity> = IsMarked<C> extends true ? { readonly principal: Identity } : object;

/**
 * Pushes a record's marker onto each of its children, so a marked fragment
 * protects every procedure beneath it. The runtime walk in `routerOf` carries
 * the same fact as an argument; these two must agree.
 */
type Inherit<T, Marked extends boolean> = Marked extends true ? Authenticated<T> : T;

/**
 * Whether the contract marks anything, anywhere — a yes/no, not a type, since
 * the contract names no principal. It is what makes the authenticator
 * dependency conditional on both `build` overloads, and the type side of the
 * `hasMarked` walk below; these two must agree.
 */
export type HasMark<C> =
  IsMarked<C> extends true
    ? true
    : C extends ProcedureContract<infer _I, infer _O, infer _E>
      ? false
      : true extends {
            readonly [K in Exclude<keyof C, PrincipalKey>]: HasMark<C[K]>;
          }[Exclude<keyof C, PrincipalKey>]
        ? true
        : false;

/**
 * Whether the contract marks anything, anywhere. Walked once, at composition,
 * because it is what makes the authenticator dependency conditional: a router
 * with no marked leaf declares no such need, so an application with no
 * protected route provides nothing. The type side of the same condition is
 * `HasMark<C>` on both `build` overloads; these two must agree.
 */
const hasMarked = (node: unknown, seen: WeakSet<object> = new WeakSet()): boolean => {
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  // Every object, not only a plain record: `routerOf` reaches a mark through
  // whatever `contract[key]` holds, so anything this walk declines to enter is
  // a mark it can miss and the walk cannot — and missing one is the unsafe
  // direction. `seen` is what makes entering everything terminate, since a
  // schema is free to be recursive.
  seen.add(node);
  if (isAuthenticated(node)) return true;
  return Object.values(node as Record<string, unknown>).some((child) => hasMarked(child, seen));
};

// Walks the implementation record next to the implementer and the contract: a
// function is a procedure and becomes `implementer.result(fn)`, anything else
// is a nested router. The types above are the whole check; the walk trusts
// them, and drops a key the implementer has no node for rather than defecting
// on it. `inherited` carries a marked record's mark down to its procedures —
// `isAuthenticated` answers for one node only — the same way `Inherit<T, P>`
// carries it in the types. `.use` must come BEFORE `.result`: `.result`
// returns an `ImplementedProcedure`, whose own `.use` has no `.result` left.
const routerOf = (
  implementer: Record<string, unknown>,
  implementation: Record<string, unknown>,
  contract: Record<string, unknown>,
  inherited: boolean,
  authenticate: AuthenticatorService<unknown> | undefined,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(implementation).flatMap(([key, value]) => {
      const node = implementer[key] as
        | (Record<string, unknown> & {
            readonly result: (fn: unknown) => unknown;
            readonly use: (middleware: unknown) => Record<string, unknown> & {
              readonly result: (fn: unknown) => unknown;
            };
          })
        | undefined;
      if (node === undefined) return [];
      const child = contract[key];
      const marked =
        inherited || (typeof child === "object" && child !== null && isAuthenticated(child));
      if (typeof value === "function") {
        // Fail closed: a mark with no authenticator behind it refuses every
        // caller rather than serving the leaf unprotected.
        const target = marked
          ? node.use(principalMiddleware(authenticate ?? noAuthenticator))
          : node;
        return [[key, target.result(value)]];
      }
      return [
        [
          key,
          routerOf(
            node,
            value as Record<string, unknown>,
            (child ?? {}) as Record<string, unknown>,
            marked,
            authenticate,
          ),
        ],
      ];
    }),
  );
