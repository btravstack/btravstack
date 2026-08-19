import type { Authenticated, PrincipalKey, PrincipalOf } from "@btravstack/contract";
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
import { RPCHandler } from "@orpc/server/node";
import "@unthrown/orpc/extensions/result";

import { HttpHandler } from "./handler.js";

export type OrpcOptions = {
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
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
  return Provider(HttpHandler)([HttpRouterPort], {
    sync: (service) => {
      const rpc = new RPCHandler(service);
      return (request, response) => rpc.handle(request, response, { prefix });
    },
  });
};

/**
 * The router as a provider, **from the contract**:
 *
 * ```ts
 * const orderRouter = HttpRouter(orderContract)([PlaceOrder, FindOrder], {
 *   sync: (place, find) => ({
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
 * `Provider(port)([deps], { sync })` on the starter's own router port, with
 * one difference: `sync` returns the implementation record and the router is
 * built from it. There is no name to give — a process serves one router, so
 * the port is the starter's (`HttpRouterPort`), and the provider carries it
 * typed (`orderRouter.port`) for whoever else needs the class.
 *
 * The second call also takes a **keyed record of controllers** instead of
 * `(deps, { sync })`: `HttpRouter(contract)({ orders: ordersController, users:
 * usersController })`, one `HttpController` per top-level contract key. Each
 * fragment is composed as-is rather than re-implemented, and every key of the
 * contract must be covered — a missing or extra key is a compile error.
 */
export const HttpRouter = <C extends Record<string, RouterContract>>(contract: C) => {
  // The implementer is walked untyped: `Implementation<C>` above is the
  // whole check — a key the contract does not declare is a compile error
  // there, and `routerOf` skips one anyway rather than reading `.result` off
  // `undefined` — and `implement(contract)`'s own type is a per-contract
  // intersection this generic body cannot index into.
  const os = implement(contract) as unknown as Record<string, unknown> & {
    readonly router: (record: Record<string, unknown>) => Router<Record<never, never>>;
  };

  function build<const D extends readonly AnyPort[]>(
    deps: D,
    options: {
      readonly sync: (
        ...services: { [K in keyof D]: ServiceOf<InstanceType<D[K]>> }
      ) => Implementation<C>;
    },
  ): Provider<
    PortInstance<"HttpRouter", Router<Record<never, never>>>,
    never,
    InstanceType<D[number]>
  > & {
    readonly port: PortClassOf<"HttpRouter", Router<Record<never, never>>>;
  };
  function build<M extends { readonly [K in keyof C]: ControllerFor<C[K]> }>(
    controllers: M & { readonly [K in Exclude<keyof M, keyof C>]: never },
  ): Provider<
    PortInstance<"HttpRouter", Router<Record<never, never>>>,
    never,
    InstanceType<M[keyof M]["port"]>
  > & { readonly port: PortClassOf<"HttpRouter", Router<Record<never, never>>> };
  function build(depsOrControllers: unknown, options?: unknown): unknown {
    // `Array.isArray` discriminates the two forms, the same way
    // `Provider(port)(depsOrOptions, …)` discriminates its own.
    if (Array.isArray(depsOrControllers)) {
      const sync = (...services: readonly unknown[]): Router<Record<never, never>> =>
        os.router(
          routerOf(
            os,
            (options as { readonly sync: (...s: readonly unknown[]) => unknown }).sync(
              ...services,
            ) as Record<string, unknown>,
          ),
        );
      return Provider(HttpRouterPort)(depsOrControllers as readonly AnyPort[], { sync } as never);
    }

    const entries = Object.entries(depsOrControllers as Record<string, { readonly port: AnyPort }>);
    const sync = (...services: readonly unknown[]): Router<Record<never, never>> =>
      os.router(
        routerOf(os, Object.fromEntries(entries.map(([key], index) => [key, services[index]]))),
      );
    return Provider(HttpRouterPort)(
      entries.map(([, controller]) => controller.port),
      { sync } as never,
    );
  }

  return build;
};

/** A controller for one fragment — what `HttpController` returns, as the keyed form consumes it. */
type ControllerFor<Fragment extends RouterContract> = {
  readonly port: PortClassOf<string, Implementation<Fragment>>;
};

/**
 * What `HttpRouter(contract)(…)(…, { sync })`'s `sync` returns: the contract's
 * shape, with a `Result`-returning handler at every procedure — the parameter
 * `@unthrown/orpc`'s `.result()` takes on that procedure's implementer, so
 * the input is the contract's parsed input, the output its declared output
 * and the `errors` helpers its declared error map.
 */
export type Implementation<C extends RouterContract> =
  C extends ProcedureContract<infer I, infer O, infer E>
    ? Parameters<
        ProcedureImplementer<DefaultInitialContext & object, ContextOf<C>, I, O, E>["result"]
      >[0]
    : {
        readonly [K in Exclude<keyof C, PrincipalKey>]: C[K] extends RouterContract
          ? Implementation<Inherit<C[K], PrincipalOf<C>>>
          : never;
      };

/**
 * What a leaf's handler gets on `opts.context`: the principal when the leaf is
 * marked, and `object` — today's spelling, unchanged — when it is not. It rides
 * oRPC's own context channel, injected into `ProcedureImplementer`'s second
 * type parameter, so this package adds no second handler parameter and wraps no
 * `.result()` handler. `[X] extends [never]` rather than `X extends never`: a
 * bare check distributes over a union and answers `never` for every arm.
 */
type ContextOf<C> = [PrincipalOf<C>] extends [never]
  ? object
  : { readonly principal: PrincipalOf<C> };

/**
 * Pushes a record's marker onto each of its children, so a marked fragment
 * protects every procedure beneath it. The runtime walk in `routerOf` carries
 * the same fact as an argument; these two must agree.
 */
type Inherit<T, P> = [P] extends [never] ? T : Authenticated<T, P>;

/**
 * The principal a contract declares anywhere in its tree, or `never` if none
 * does — what a composition root reads to know which authenticator it owes.
 */
export type ContractPrincipal<C extends RouterContract> = [PrincipalOf<C>] extends [never]
  ? C extends ProcedureContract<infer _I, infer _O, infer _E>
    ? never
    : {
        readonly [K in Exclude<keyof C, PrincipalKey>]: C[K] extends RouterContract
          ? ContractPrincipal<C[K]>
          : never;
      }[Exclude<keyof C, PrincipalKey>]
  : PrincipalOf<C>;

// Walks the implementation record next to the implementer: a function is a
// procedure and becomes `implementer.result(fn)`, anything else is a nested
// router. The types above are the whole check; the walk trusts them, and
// drops a key the implementer has no node for rather than defecting on it.
const routerOf = (
  implementer: Record<string, unknown>,
  implementation: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(implementation).flatMap(([key, value]) => {
      const node = implementer[key] as
        | (Record<string, unknown> & { readonly result: (fn: unknown) => unknown })
        | undefined;
      if (node === undefined) return [];
      return typeof value === "function"
        ? [[key, node.result(value)]]
        : [[key, routerOf(node, value as Record<string, unknown>)]];
    }),
  );
