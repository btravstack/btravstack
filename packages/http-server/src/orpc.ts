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
import { CONTROLLER_PREFIX, type ControllerKeyOf, type ControllerPortOf } from "./controller.js";
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
 * The second call also accepts an **array of pieces** in place of
 * `(deps, { sync })` — each an `HttpController(contract, path)` over one node
 * of the contract tree, at any depth, the paths partitioning the contract's
 * procedures: an uncovered leaf is refused against the
 * `"UNCOVERED CONTROLLERS — …"` marker, a piece nested inside another piece's
 * fragment against `"OVERLAPPING CONTROLLERS — …"`, and a contract whose top
 * level carries a dotted key — which no piece path can encode — against
 * `"UNSLICEABLE CONTRACT KEY — …"`, which points at this form's `(deps, arm)`
 * arm instead.
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
    // Declared LAST on purpose: TypeScript reports the last overload's
    // failure, so a bad array is refused against the markers below rather than
    // degrading to di's `Qualification`, which names nothing (measured in
    // `packages/amqp-worker`, same mechanism). The marker is a sentence
    // because it is the only actionable part of the diagnostic and it prints
    // last, past the caller's own wide piece type.
    function build<const T extends readonly PieceOf<C, Schemes>[]>(
      pieces: [Unsliceable<C>] extends [never]
        ? [Uncovered<C, KeyOfPiece<T[number]>>] extends [never]
          ? [Overlapping<KeyOfPiece<T[number]>>] extends [never]
            ? T
            : readonly [
                "OVERLAPPING CONTROLLERS — a piece sits inside another piece's fragment",
                Overlapping<KeyOfPiece<T[number]>>,
              ]
          : readonly [
              "UNCOVERED CONTROLLERS — the contract declares a procedure this array does not cover",
              Uncovered<C, KeyOfPiece<T[number]>>,
            ]
        : readonly [
            "UNSLICEABLE CONTRACT KEY — a top-level key contains a dot, which a piece path cannot encode; serve this contract with the (deps, arm) form instead",
            Unsliceable<C>,
          ],
    ): Built<Auth, InstanceType<T[number]["port"]> | SchemePortsOf<C>>;
    function build(depsOrPieces: unknown, options?: unknown): unknown {
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

      // One array argument is never a valid `Provider(port)` call — its arms
      // are `(deps, options)` and `(options)`, both records — so `Array.isArray`
      // alone identifies the composing arm.
      if (options === undefined && Array.isArray(depsOrPieces)) {
        const pieces = depsOrPieces as readonly { readonly port: AnyPort }[];
        // Each piece is declared under the dotted path its port id carries;
        // `nest` folds those paths back into the contract's own tree before
        // the `routerOf` walk.
        const deps = Object.fromEntries(
          pieces.map((piece) => [piece.port.portId.slice(CONTROLLER_PREFIX.length), piece.port]),
        );
        const sync = (services: Record<string, unknown>): Router<Record<never, never>> =>
          routerFrom(nest(own(services)), services);
        return Object.assign(Provider(HttpRouterPort)(withSchemes(deps), { sync } as never), {
          authenticators,
        });
      }

      // `(deps, arm)` and `(arm)` are told apart by plain arity, as everywhere
      // else in the family.
      const supplied = (options ?? depsOrPieces) as {
        readonly sync: (s: Record<string, unknown>) => unknown;
      };
      const deps = options === undefined ? {} : (depsOrPieces as Record<string, AnyPort>);
      const sync = (services: Record<string, unknown>): Router<Record<never, never>> => {
        const call = supplied.sync as (...args: readonly unknown[]) => unknown;
        // The arm-only form's `sync` is typed `() => …`, so it is handed
        // nothing — the arity guarantee `Provider` makes a no-deps factory.
        const built = options === undefined ? call() : call(own(services));
        return routerFrom(built as Record<string, unknown>, services);
      };
      return Object.assign(Provider(HttpRouterPort)(withSchemes(deps), { sync } as never), {
        authenticators,
      });
    }

    return build;
  };

// Namespaced so a scheme's key cannot collide with one the caller wrote. The
// trailing colon is part of the prefix: the scheme name follows it.
const AUTHENTICATOR = "@btravstack/http-server/authenticator:";

// A piece's dotted path becomes the nesting the contract already has, so
// `routerOf` walks the same tree it always did — marks, inheritance and the
// stray-key drop included. Written here rather than pushed into the walk
// because the walk is shared with the `(deps, arm)` form, which never nests.
// `path.split(".")` cannot tell a path SEPARATOR from a literal dot inside one
// contract key, so nothing reaching here may carry one: `ControllerKeyOf` drops
// dotted keys at every level, and `Unsliceable` refuses a contract whose TOP
// level has one. Only the top level, because a piece at a dotted key's PARENT
// hands its implementation record to `routerOf` whole — this walk splits paths,
// never the keys underneath them.
const nest = (flat: Record<string, unknown>): Record<string, unknown> => {
  // Null-prototype, and that is a safety property rather than a style: on a
  // plain `{}`, `node["__proto__"] ??= {}` reads `Object.prototype` — not
  // nullish, so nothing is assigned — and the walk then writes the piece onto
  // `Object.prototype` itself (measured). `routerOf` only ever `Object.entries`
  // what it is handed, so nothing downstream needs the prototype.
  const node0 = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;
  const out = node0();
  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split(".");
    const last = segments.pop() as string;
    let node = out;
    for (const segment of segments) {
      node[segment] ??= node0();
      node = node[segment] as Record<string, unknown>;
    }
    node[last] = value;
  }
  return out;
};

/**
 * One piece of the router — what `HttpController(contract, key)(…)` returns, as
 * the composing form consumes it. The port stays spelled INLINE rather than as
 * `ControllerPortOf<C, K, Schemes>` — kept as a regression guard, not for a hole
 * open today. On #116's flat `ControllerKeyOf` the alias spelling let TypeScript's
 * alias-variance fast path skip the contravariant handler check, so a marked
 * piece slipped under the unmarked contract. On the current recursive-path
 * `ControllerKeyOf` both spellings refuse that direction (re-measured
 * 2026-08-25, TS 7.0.2, same version as #116). The fast path is a compiler
 * heuristic that has already changed behaviour across one key-shape refactor,
 * so a future one could reopen it with no test failing; the inline spelling
 * costs one type literal and closes that off. The gate itself is
 * `controller.test-d.ts`'s refused
 * `api.HttpRouter(contract)([markedOrders, markedUsers])`.
 */
type PieceOf<C extends Record<string, RouterContract>, Schemes> = {
  readonly [K in ControllerKeyOf<C>]: {
    readonly port: {
      readonly portId: `${typeof CONTROLLER_PREFIX}${K}`;
      new (): InstanceType<ControllerPortOf<C, K, Schemes>>;
    };
  };
}[ControllerKeyOf<C>];

/** The key a piece carries, read back off its port id. */
type KeyOfPiece<P> = P extends {
  readonly port: { readonly portId: `${typeof CONTROLLER_PREFIX}${infer K}` };
}
  ? K
  : never;

/** Every path to a PROCEDURE — the leaves a cover must partition. */
type LeafPathsOf<C, P extends string = ""> =
  C extends ProcedureContract<infer _I, infer _O, infer _E>
    ? P
    : // The same TS2589 guard `ControllerKeyOf` needs: an index-signature
      // record short-circuits to `string` rather than recursing over its keys.
      string extends keyof C
      ? string
      : {
          [K in Exclude<keyof C, PrincipalKey> & string]: LeafPathsOf<
            C[K],
            P extends "" ? K : `${P}.${K}`
          >;
        }[Exclude<keyof C, PrincipalKey> & string];

/** Whether leaf `L` sits at, or under, piece path `P`. */
type CoveredBy<L extends string, P extends string> = L extends P | `${P}.${string}` ? true : false;

/** The procedures no piece in the array covers. */
type Uncovered<C, Paths extends string> =
  LeafPathsOf<C> extends infer L extends string
    ? L extends string
      ? true extends { [P in Paths]: CoveredBy<L, P> }[Paths]
        ? never
        : L
      : never
    : never;

/**
 * Top-level contract keys carrying a literal dot. A piece path is joined and
 * split on `.`, so such a key cannot be named — and unlike a dotted key deeper
 * in the tree, it has no nameable ancestor a piece could cover it from, the
 * array form being rooted at the contract itself. Reported ahead of `Uncovered`
 * because "no piece can name this" is a different fact from "no piece did".
 */
type Unsliceable<C> = Extract<Exclude<keyof C, PrincipalKey> & string, `${string}.${string}`>;

/**
 * A piece path nested inside another piece's path. Both would implement the
 * same procedures, and — unlike two pieces under ONE path, which are one port
 * id and therefore di's duplicate-provider defect — these are two distinct ids
 * di cannot see conflicting, so the `nest` rebuild would silently let one win.
 * This gate is the only thing standing between a dotted path and that.
 */
type Overlapping<Paths extends string> = {
  [P in Paths]: Paths extends infer Q extends string
    ? Q extends string
      ? Q extends P
        ? never
        : P extends `${Q}.${string}`
          ? P
          : never
      : never
    : never;
}[Paths];

/**
 * What a `sync` arm returns: the contract's shape, with a `Result`-returning
 * handler at every procedure — the parameter `@unthrown/orpc`'s `.result()`
 * takes on that procedure's implementer.
 */
// `C` is deliberately unbounded: `controller.ts` instantiates this with the
// deferred `FragmentAt<C, K>`, whose branches TypeScript cannot prove
// `RouterContract` for a generic contract — the mapped arm below already
// guards each child with `C[K] extends RouterContract`.
export type Implementation<C, Schemes = never, R extends Requirements = never> =
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
 * The requirements in force at a node: its own, or the inherited ones. Nearest
 * mark wins. Exported for `controller.ts`, whose `FragmentAt` folds it down a
 * dotted path.
 */
export type Effective<C, R extends Requirements> = IsMarked<C> extends true ? RequirementsOf<C> : R;

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
 * of `routerOf`'s `inherited` argument; the two must agree. Exported for
 * `controller.ts`, which applies it at the mint.
 */
export type Inherit<T, R extends Requirements> = [R] extends [never]
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
