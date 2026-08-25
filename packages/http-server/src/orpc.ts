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
   * policy configuring the transport; not a middleware slot for application
   * logic, which the package still declines.
   */
  readonly plugins?: readonly NodeHttpHandlerPlugin<DefaultInitialContext>[];
};

/**
 * The router's port — one id, the starter's own, which an application never
 * names. Spelled through `PortClassOf` / `PortInstance` rather than a `class`
 * so a consumer's declaration emit can name the provider's type (TS4023
 * otherwise). Exported for this package's tests, not from `index.ts`.
 */
export const HttpRouterPort = Port("HttpRouter") as PortClassOf<
  "HttpRouter",
  Router<Record<never, never>>
>;
export type HttpRouterPort = PortInstance<"HttpRouter", Router<Record<never, never>>>;

/**
 * The oRPC starter: a provider of `HttpHandler` built from the router port,
 * mounted under `prefix`. A request oRPC does not match resolves unwritten and
 * the runtime answers its `404`. Nothing here maps a `Result` to a status.
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

/** What every `HttpRouter` arm returns; only the needs channel `N` differs. */
type Built<Auth, N> = Provider<
  PortInstance<"HttpRouter", Router<Record<never, never>>>,
  never,
  N
> & {
  readonly port: PortClassOf<"HttpRouter", Router<Record<never, never>>>;
  /**
   * The scheme authenticators `defineHttp` bound, carried on the router because
   * the router is what needs them: they discharge its scheme ports.
   */
  readonly authenticators: readonly Auth[];
};

/**
 * The router as a provider, from the contract — minted by `defineHttp`, so its
 * handlers are typed by the scheme registry that call inferred.
 *
 * ```ts
 * const orderRouter = api.HttpRouter(orderContract)({ place: PlaceOrder }, {
 *   sync: ({ place }) => ({
 *     orders: {
 *       place: ({ errors }, input) => place.execute(input.id, input.quantity).map(view),
 *     },
 *   }),
 * });
 * ```
 *
 * An implementation is a record shaped like the contract whose leaves are plain
 * `Result`-returning functions, typed by the contract at the call: a typo'd
 * key, a missing procedure or a wrong output is a compile error here.
 *
 * The second call also accepts a keyed record of **controllers** in place of
 * `(deps, { sync })` — one `HttpController` per top-level contract key, every
 * key covered.
 */
export const routerFor =
  <Schemes, Auth extends AnyProvider = never, Vocab = Record<never, never>>(
    authenticators: readonly Auth[],
  ) =>
  <C extends Record<string, RouterContract>>(contract: C & ScopeGate<C, Vocab>) => {
    // Walked untyped: `Implementation<C>` is the whole check, and
    // `implement(contract)`'s own type is a per-contract intersection this
    // generic body cannot index into.
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

      // Three forms, two arguments' worth of arity — the one helper here that
      // cannot discriminate on arity alone. The two one-argument forms are told
      // apart by whether `sync` holds a FUNCTION: total, not a heuristic, since
      // a contract key called `sync` would hold a controller, never a function.
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
          // nothing — the arity guarantee `Provider` makes a no-deps factory.
          const built = armOnly === undefined ? call(own(services)) : call();
          return routerFrom(built as Record<string, unknown>, services);
        };
        return Object.assign(Provider(HttpRouterPort)(withSchemes(deps), { sync } as never), {
          authenticators,
        });
      }

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

// Namespaced so a scheme's key cannot collide with one the caller wrote. The
// trailing colon is part of the prefix: the scheme name follows it.
const AUTHENTICATOR = "@btravstack/http-server/authenticator:";

/** A controller for one fragment — what `HttpController` returns, as the keyed form consumes it. */
type ControllerFor<Fragment extends RouterContract, Schemes = never> = {
  readonly port: PortClassOf<string, Implementation<Fragment, Schemes>>;
};

/**
 * What a `sync` arm returns: the contract's shape, with a `Result`-returning
 * handler at every procedure — the parameter `@unthrown/orpc`'s `.result()`
 * takes on that procedure's implementer.
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

/** The requirements in force at a node: its own, or the inherited ones. Nearest mark wins. */
type Effective<C, R extends Requirements> = IsMarked<C> extends true ? RequirementsOf<C> : R;

/**
 * What a leaf's handler gets on `opts.context`, riding oRPC's own context
 * channel. A leaf reached without `defineHttp` sees `Schemes = never`, so
 * `principal` is `never` and any read of it is a compile error — the "use the
 * factory" signal.
 */
type ContextOf<C, R extends Requirements, Schemes> = [Effective<C, R>] extends [never]
  ? object
  : { readonly principal: Principal<SchemesOf<Effective<C, R>>, Schemes> };

/**
 * Pushes a record's requirements onto a child that carries none. The type side
 * of `routerOf`'s `inherited` argument; the two must agree.
 */
type Inherit<T, R extends Requirements> = [R] extends [never]
  ? T
  : IsMarked<T> extends true
    ? T
    : Authenticated<T, R>;

/**
 * Every requirement the contract carries, anywhere. Over-, never
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

/** Every scope string the contract names for scheme `K`, across every requirement. */
type ScopesIn<R, K extends string> = R extends Requirements
  ? {
      // `K extends keyof R[I]` first, never `R[I][K & keyof R[I]]`: indexing a
      // requirement that does not name `K` gives `never`, and inferring `S`
      // from `never` falls back to its constraint `string`, so every scope
      // looks grantable the moment two requirements name different schemes.
      [I in keyof R]: K extends keyof R[I]
        ? R[I][K] extends readonly (infer S extends string)[]
          ? S
          : never
        : never;
    }[number]
  : never;

/** A scope the contract names that its scheme's authenticator cannot grant. */
type Ungrantable<C, Vocab> = {
  // A scheme the registry does not know is di's to report, not this gate's:
  // treating it as an empty vocabulary turns a misspelled SCHEME into a scope
  // complaint, the wrong diagnostic and earlier than the right one.
  [K in SchemesIn<AllRequirementsOf<C>>]: K extends keyof Vocab
    ? Exclude<ScopesIn<AllRequirementsOf<C>, K>, Vocab[K]>
    : never;
}[SchemesIn<AllRequirementsOf<C>>];

/**
 * The scope half of what `routerFor` checks. It rides an intersection on the
 * `contract` parameter, and its failure branch is an object with one required
 * property, which is what makes the diagnostic name the offending scope.
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
 * channel. The runtime side is `schemesOf`; these two must agree.
 */
type SchemePortsOf<C> =
  SchemesIn<AllRequirementsOf<C>> extends infer S extends string
    ? S extends string
      ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
      : never
    : never;

/**
 * Whether the contract marks anything, anywhere. Nothing inside this package
 * consumes it; it is exported for tooling over a contract — an OpenAPI
 * generator deciding whether to emit `security` at all.
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
 * Every scheme the contract names, anywhere — the router's scheme
 * dependencies. The type side is `SchemePortsOf<C>`; these two must agree.
 */
const schemesOf = (contract: unknown): readonly string[] => {
  const found = new Set<string>();
  const walk = (node: unknown, seen: WeakSet<object>): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    // Every object, not only a plain record: anything this walk declines to
    // enter is a mark it can miss, and missing one is the unsafe direction.
    // `seen` is what makes entering everything terminate.
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
// function is a procedure, anything else a nested router. `inherited` carries a
// marked record's requirements down to its procedures, as `Inherit<T, R>` does
// in the types. `.use` must come BEFORE `.result`: `.result` returns an
// `ImplementedProcedure`, whose own `.use` has no `.result` left.
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
