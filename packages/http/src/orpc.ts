import {
  isAuthenticated,
  type Authenticated,
  type IsMarked,
  type PrincipalKey,
  type Requirements,
  type RequirementsOf,
} from "@btravstack/contract";
import {
  Port,
  Provider,
  type AnyPort,
  type AnyProvider,
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

import { authenticatorPort, principalMiddleware, type AuthenticatorService } from "./auth.js";
import { HttpHandler } from "./handler.js";
import type { Principal, SchemesOf } from "./principal.js";

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
 * The router as a provider, **from the contract** — minted by `defineHttp`, so
 * its handlers are typed by the scheme registry that call inferred:
 *
 * ```ts
 * const orderRouter = api.HttpRouter(orderContract)({ place: PlaceOrder, find: FindOrder }, {
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
 * two apart, exactly as `Provider(port)(…)` discriminates its own: `api.HttpRouter(contract)({ orders: ordersController, users:
 * usersController })`, one `HttpController` per top-level contract key. Each
 * fragment is composed as-is rather than re-implemented, and every key of the
 * contract must be covered — a missing or extra key is a compile error.
 */
/** What every `HttpRouter` arm returns; only the needs channel `N` differs. */
type Built<Auth, N> = Provider<
  PortInstance<"HttpRouter", Router<Record<never, never>>>,
  never,
  N
> & {
  readonly port: PortClassOf<"HttpRouter", Router<Record<never, never>>>;
  /**
   * The scheme authenticators `defineHttp` bound, carried here so `HttpModule`
   * can put them in `provides` off the one option an application already
   * passes. It rides the router because the router is what needs them: they
   * are the providers that discharge its scheme ports.
   */
  readonly authenticators: readonly Auth[];
};

export const routerFor =
  <Schemes, Auth extends AnyProvider = never, Vocab = Record<never, never>>(
    authenticators: readonly Auth[],
  ) =>
  <C extends Record<string, RouterContract>>(contract: C & ScopeGate<C, Vocab>) => {
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
        }) => Implementation<C, Schemes>;
      },
    ): Built<Auth, InstanceType<D[keyof D]> | SchemePortsOf<C>>;
    function build(options: {
      readonly sync: () => Implementation<C, Schemes>;
    }): Built<Auth, SchemePortsOf<C>>;
    function build<
      M extends {
        readonly [K in Exclude<keyof C, PrincipalKey>]: ControllerFor<
          Inherit<C[K], RequirementsOf<C>>,
          Schemes
        >;
      },
    >(
      controllers: M & {
        readonly [
          K in Exclude<keyof M, Exclude<keyof C, PrincipalKey>>
        ]: `UNDECLARED KEY — the contract declares no fragment under ${K & string}`;
      },
    ): Built<Auth, InstanceType<M[keyof M]["port"]> | SchemePortsOf<C>>;
    function build(depsOrControllers: unknown, options?: unknown): unknown {
      const schemes = schemesOf(contract);
      // Each scheme's port rides a NAMESPACED key on the deps record, for the
      // same reason `tapped`'s port id is namespaced: the other keys are the
      // caller's own names, and these must not be able to collide with a
      // dependency somebody called `user`.
      const own = (services: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(services).filter(([key]) => !key.startsWith(AUTHENTICATOR)),
        );
      const withSchemes = (deps: Record<string, AnyPort>): Record<string, AnyPort> => ({
        ...deps,
        ...Object.fromEntries(
          schemes.map((scheme) => [`${AUTHENTICATOR}${scheme}`, authenticatorPort(scheme)]),
        ),
      });
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
            Object.fromEntries(
              schemes.map((scheme) => [
                scheme,
                services[`${AUTHENTICATOR}${scheme}`] as AuthenticatorService<unknown>,
              ]),
            ),
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
        return Object.assign(Provider(HttpRouterPort)(withSchemes(deps), { sync } as never), {
          authenticators,
        });
      }

      // The controllers record is keyed by contract key, and so is the services
      // record it becomes — so the implementation IS what the graph resolved,
      // with nothing to reassemble positionally.
      const controllers = depsOrControllers as Record<string, { readonly port: AnyPort }>;
      const sync = (services: Record<string, unknown>): Router<Record<never, never>> =>
        routerFrom(own(services), services);
      return Object.assign(
        Provider(HttpRouterPort)(
          withSchemes(
            Object.fromEntries(
              Object.entries(controllers).map(([key, controller]) => [key, controller.port]),
            ),
          ),
          { sync } as never,
        ),
        { authenticators },
      );
    }

    return build;
  };

// Namespaced so it cannot collide with a key the caller wrote; see `build`.
// The trailing colon is part of the prefix: the scheme name follows it.
const AUTHENTICATOR = "@btravstack/http/authenticator:";

/** A controller for one fragment — what `HttpController` returns, as the keyed form consumes it. */
type ControllerFor<Fragment extends RouterContract, Schemes = never> = {
  readonly port: PortClassOf<string, Implementation<Fragment, Schemes>>;
};

/**
 * What `HttpRouter(contract)(…)(…, { sync })`'s `sync` returns: the contract's
 * shape, with a `Result`-returning handler at every procedure — the parameter
 * `@unthrown/orpc`'s `.result()` takes on that procedure's implementer, so
 * the input is the contract's parsed input, the output its declared output
 * and the `errors` helpers its declared error map.
 */
export type Implementation<
  C extends RouterContract,
  Schemes = never,
  R extends Requirements = never,
> =
  C extends ProcedureContract<infer I, infer O, infer E>
    ? Parameters<
        ProcedureImplementer<
          DefaultInitialContext & object,
          ContextOf<C, R, Schemes>,
          I,
          O,
          E
        >["result"]
      >[0]
    : {
        readonly [K in Exclude<keyof C, PrincipalKey>]: C[K] extends RouterContract
          ? Implementation<C[K], Schemes, Effective<C, R>>
          : never;
      };

/**
 * The requirements actually in force at a node: its own, or the inherited ones.
 * Nearest mark wins, which is OpenAPI's own rule.
 */
type Effective<C, R extends Requirements> = IsMarked<C> extends true ? RequirementsOf<C> : R;

/**
 * What a leaf's handler gets on `opts.context`: the principal its effective
 * requirements name, and `object` — today's spelling, unchanged — when it has
 * none. It rides oRPC's own context channel, injected into
 * `ProcedureImplementer`'s second type parameter, so this package adds no
 * second handler parameter and wraps no `.result()` handler.
 *
 * The contract says **which schemes** protect a leaf; `Schemes` — the registry
 * `defineHttp` infers from its authenticators — says what each one resolves to.
 * A leaf reached without the factory sees `Schemes = never`, so `principal` is
 * `never` and any read of it is a compile error — the "use the factory" signal,
 * rather than a principal invented from a contract that names none.
 */
type ContextOf<C, R extends Requirements, Schemes> = [Effective<C, R>] extends [never]
  ? object
  : { readonly principal: Principal<SchemesOf<Effective<C, R>>, Schemes> };

/**
 * Pushes a record's requirements onto a child that carries none, so a marked
 * fragment protects every procedure beneath it. Nearest mark wins: a node with
 * its own requirements is left alone. This is the type side of `routerOf`'s
 * `inherited` argument; the two must agree.
 */
type Inherit<T, R extends Requirements> = [R] extends [never]
  ? T
  : IsMarked<T> extends true
    ? T
    : Authenticated<T, R>;

/**
 * Every requirement the contract carries, anywhere in its tree — the same walk
 * as `HasMark<C>`, keeping what it found instead of answering yes. Over-, never
 * under-approximating: a requirement a nearer mark shadows still contributes
 * its scheme, which costs a dep nothing uses rather than a missing one.
 */
type AllRequirementsOf<C> =
  | RequirementsOf<C>
  | (C extends ProcedureContract<infer _I, infer _O, infer _E>
      ? never
      : {
          readonly [K in Exclude<keyof C, PrincipalKey>]: AllRequirementsOf<C[K]>;
        }[Exclude<keyof C, PrincipalKey>]);

/** Distributes `SchemesOf` over the union of requirement tuples the walk collected. */
type SchemesIn<R> = R extends Requirements ? SchemesOf<R> : never;

/**
 * Every scope string the contract names for scheme `K`, across every
 * requirement the walk collected. A requirement that names no scopes
 * contributes `never`, so the common case reaches the gate below with nothing
 * to check and costs it nothing.
 */
type ScopesIn<R, K extends string> = R extends Requirements
  ? {
      // `K extends keyof R[I]` first, and not `R[I][K & keyof R[I]]`: indexing a
      // requirement that does not name `K` gives `never`, and inferring `S`
      // from `never` falls back to its CONSTRAINT — `string` — so every scope
      // looked grantable the moment two requirements named different schemes
      // (measured).
      [I in keyof R]: K extends keyof R[I]
        ? R[I][K] extends readonly (infer S extends string)[]
          ? S
          : never
        : never;
    }[number]
  : never;

/**
 * A scope the contract names that its scheme's authenticator cannot grant —
 * a typo, or a scope asked of a scheme declared with no vocabulary at all
 * (`Scope = never`, so everything is ungrantable).
 */
type Ungrantable<C, Vocab> = {
  [K in SchemesIn<AllRequirementsOf<C>>]: Exclude<
    ScopesIn<AllRequirementsOf<C>, K>,
    K extends keyof Vocab ? Vocab[K] : never
  >;
}[SchemesIn<AllRequirementsOf<C>>];

/**
 * The scope half of what `routerFor` checks, and the sibling of the scheme-name
 * check di already performs by leaving an unknown scheme's port unmet. Nothing
 * ties a contract's scope STRINGS to a scheme's vocabulary otherwise: the route
 * compiles, passes every gate command, and then refuses every caller with a
 * permanent 403 and no diagnostic anywhere (#90).
 *
 * It rides an intersection on the `contract` parameter — `unknown` when
 * satisfied, so the parameter type is untouched — and its failure branch is an
 * object with one required property, because that is what makes the diagnostic
 * name the offending scope rather than restate the contract (the same shape
 * di's `NeedsGate` uses, and for the same measured reason).
 */
type ScopeGate<C, Vocab> = [Ungrantable<C, Vocab>] extends [never]
  ? unknown
  : {
      readonly "UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it": Ungrantable<
        C,
        Vocab
      >;
    };

/**
 * One port instance per scheme the contract names, as the router's needs
 * channel. The naked `S` distributes, so two schemes are two distinct port
 * types — a scheme with no authenticator behind it is di's own unmet need
 * naming `HttpAuthenticator:<scheme>`, not a gate this package writes. The
 * runtime side is `schemesOf` below; these two must agree.
 */
type SchemePortsOf<C> =
  SchemesIn<AllRequirementsOf<C>> extends infer S extends string
    ? S extends string
      ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
      : never
    : never;

/**
 * Whether the contract marks anything, anywhere — a yes/no, not a type, since
 * the contract names no principal.
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
 * Every scheme the contract names, anywhere. Walked once, at composition,
 * because it is what the router's dependencies are: one port per scheme, so an
 * application with no protected route declares nothing. The type side is
 * `SchemePortsOf<C>` above; these two must agree.
 */
const schemesOf = (contract: unknown): readonly string[] => {
  const found = new Set<string>();
  const walk = (node: unknown, seen: WeakSet<object>): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    // Every object, not only a plain record: `routerOf` reaches a mark through
    // whatever `contract[key]` holds, so anything this walk declines to enter is
    // a mark it can miss and the walk cannot — and missing one is the unsafe
    // direction. `seen` is what makes entering everything terminate, since a
    // schema is free to be recursive.
    seen.add(node);
    for (const requirement of isAuthenticated(node) ?? [])
      for (const scheme of Object.keys(requirement)) found.add(scheme);
    // No early return on a mark: a procedure inside a marked record may name a
    // scheme of its own, and that scheme still needs a port.
    for (const child of Object.values(node as Record<string, unknown>)) walk(child, seen);
  };
  walk(contract, new WeakSet());
  return [...found];
};

// Walks the implementation record next to the implementer and the contract: a
// function is a procedure and becomes `implementer.result(fn)`, anything else
// is a nested router. The types above are the whole check; the walk trusts
// them, and drops a key the implementer has no node for rather than defecting
// on it. `inherited` carries a marked record's requirements down to its
// procedures — `isAuthenticated` answers for one node only — the same way
// `Inherit<T, R>` carries them in the types. `.use` must come BEFORE `.result`:
// `.result` returns an `ImplementedProcedure`, whose own `.use` has no
// `.result` left.
const routerOf = (
  implementer: Record<string, unknown>,
  implementation: Record<string, unknown>,
  contract: Record<string, unknown>,
  inherited: Requirements | undefined,
  authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
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
      // Nearest mark wins: this node's own requirements, or the enclosing
      // record's when it declares none.
      const declared =
        typeof child === "object" && child !== null ? isAuthenticated(child) : undefined;
      const effective = declared ?? inherited;
      if (typeof value === "function") {
        const target =
          effective === undefined ? node : node.use(principalMiddleware(effective, authenticators));
        return [[key, target.result(value)]];
      }
      return [
        [
          key,
          routerOf(
            node,
            value as Record<string, unknown>,
            (child ?? {}) as Record<string, unknown>,
            effective,
            authenticators,
          ),
        ],
      ];
    }),
  );
