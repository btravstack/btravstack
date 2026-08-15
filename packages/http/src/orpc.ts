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
 * `unknown` when the port's service is a router `RPCHandler` can serve with no
 * initial context, `never` otherwise — intersected with `R` at the call site,
 * so a port whose service is not such a router fails to typecheck there rather
 * than at the first request. A router that declares an initial context is
 * rejected too: this starter has none to hand it.
 */
export type RouterPort<R extends AnyPort> =
  ServiceOf<R> extends Router<Record<never, never>> ? unknown : never;

/**
 * The oRPC starter: a provider of `@btravstack/http`'s `HttpHandler` built
 * from a **router port** — the application provides its router as a service
 * (a provider that declares the use cases its procedures call), and this
 * turns it into the HTTP surface through oRPC's own node adapter, mounted
 * under `prefix`. A request oRPC does not match resolves unwritten and the
 * runtime answers its `404`; a defect inside a procedure is oRPC's own
 * `INTERNAL_SERVER_ERROR` collapse. Nothing here maps a `Result` to a status —
 * that is the router's `.result()` triage, at the one place a domain error
 * becomes an `ORPCError`.
 */
export const orpc = <R extends AnyPort>(router: R & RouterPort<R>, options: OrpcOptions = {}) => {
  const prefix = options.prefix ?? "/rpc";
  return Provider(HttpHandler)([router], {
    sync: (service) => {
      const rpc = new RPCHandler(service as Router<Record<never, never>>);
      return (request, response) => rpc.handle(request, response, { prefix });
    },
  });
};

/**
 * The router's port and provider in one call, **from the contract**:
 *
 * ```ts
 * const orderRouter = HttpRouter(orderContract)("OrderRouter")([PlaceOrder, FindOrder], {
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
 * The first two calls mint a port named `name` whose service is the router
 * `http()` serves, and the last is di's `Provider(port)([deps], { sync })`
 * with one difference: `sync` returns the implementation record and the
 * router is built from it. The provider it hands back carries the port typed
 * (`orderRouter.port`) for `HttpModule({ router: orderRouter })` and for
 * whoever else names it.
 */
export const HttpRouter =
  <C extends Record<string, RouterContract>>(contract: C) =>
  <const Name extends string>(name: Name) =>
  <const D extends readonly AnyPort[]>(
    deps: D,
    options: {
      readonly sync: (
        ...services: { [K in keyof D]: ServiceOf<InstanceType<D[K]>> }
      ) => Implementation<C>;
    },
  ): Provider<PortInstance<Name, Router<Record<never, never>>>, never, InstanceType<D[number]>> & {
    readonly port: PortClassOf<Name, Router<Record<never, never>>>;
  } => {
    const port = class extends Port(name)<Router<Record<never, never>>> {} as PortClassOf<
      Name,
      Router<Record<never, never>>
    >;
    // The implementer is walked untyped: `Implementation<C>` above is the
    // whole check — a key the contract does not declare is a compile error
    // there, and `routerOf` skips one anyway rather than reading `.result` off
    // `undefined` — and `implement(contract)`'s own type is a per-contract
    // intersection this generic body cannot index into.
    const os = implement(contract) as unknown as Record<string, unknown> & {
      readonly router: (record: Record<string, unknown>) => Router<Record<never, never>>;
    };
    const sync = (...services: readonly unknown[]): Router<Record<never, never>> =>
      os.router(routerOf(os, options.sync(...(services as never)) as Record<string, unknown>));
    return Provider(port)(deps, { sync } as never) as never;
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
    ? Parameters<ProcedureImplementer<DefaultInitialContext & object, object, I, O, E>["result"]>[0]
    : { readonly [K in keyof C]: C[K] extends RouterContract ? Implementation<C[K]> : never };

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
