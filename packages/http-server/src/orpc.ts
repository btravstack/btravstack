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
import {
  getAsyncIteratorObjectSchemaDetails,
  type ProcedureContract,
  type RouterContract,
} from "@orpc/contract";
import {
  implement,
  type AnyProcedure,
  type DefaultInitialContext,
  type ProcedureImplementer,
  type Router,
} from "@orpc/server";
import { RPCHandler, type NodeHttpHandlerPlugin } from "@orpc/server/node";
import {
  CORSHandlerPlugin,
  GetMethodCsrfProtectionHandlerPlugin,
  RequestLimitHandlerPlugin,
  ResponseCompressionHandlerPlugin,
  type CORSHandlerPluginOptions,
  type ResponseCompressionHandlerPluginOptions,
} from "@orpc/server/plugins";
import { RPC_DEFAULT_ALLOW_METHODS } from "@orpc/server/standard";
import "@unthrown/orpc/extensions/result";

import {
  principalMiddleware,
  schemeDeps,
  schemeServices,
  type AuthenticatorService,
} from "./auth.js";
import { CONTROLLER_PREFIX } from "./controller.js";
import { CookieSchemes, csrfOn } from "./cookie.js";
import { HttpHandler } from "./handler.js";
import { HttpConfig } from "./http-config.js";
import { HttpUnit } from "./http-runtime.js";
import type {
  AllRequirementsOf,
  Built,
  Erroneous,
  KeyOfPiece,
  Overlapping,
  PieceOf,
  KindsIn,
  Refuse,
  SchemesIn,
  ScopeGate,
  Uncovered,
  Unsliceable,
} from "./orpc-gates.js";
import type { Principal, SchemesOf } from "./principal.js";
import { unitScope } from "./unit-scope.js";
import type { KindOf, UnitFor } from "./unit.js";

export type OrpcOptions = {
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
  /**
   * The CORS policy, off unless this or `HTTP_CORS_ORIGIN` turns it on.
   *
   * The origin is decided per field, like every other pin: a record naming
   * `origin` wins, `HTTP_CORS_ORIGIN` next, and oRPC's own default — reflect
   * the request's origin — last. So `cors: true` turns CORS on and still takes
   * the deployment's `HTTP_CORS_ORIGIN` when one is set; `cors: false` is off
   * whatever the deployment says. Everything else in a
   * `CORSHandlerPluginOptions` record is verbatim.
   */
  readonly cors?: boolean | CORSHandlerPluginOptions<DefaultInitialContext>;
  /**
   * Pins `HttpConfig.bodyLimit` instead of reading `HTTP_BODY_LIMIT` (default
   * {@link DEFAULT_BODY_LIMIT}) — the largest request body a procedure will
   * read, in bytes; `false` pins the unbounded `0`. Over the limit is oRPC's
   * `PAYLOAD_TOO_LARGE`, decided on `content-length` when one is sent and while
   * streaming otherwise.
   */
  readonly bodyLimit?: number | false;
  /**
   * Response compression, off unless this or `HTTP_COMPRESSION` turns it on. `true`
   * takes oRPC's own defaults (gzip then deflate, above 1 KB); a record is
   * `ResponseCompressionHandlerPluginOptions` verbatim and turns it on. Request
   * DEcompression is not this option — it is `RequestCompressionHandlerPlugin`
   * through `plugins`.
   */
  readonly compression?: boolean | ResponseCompressionHandlerPluginOptions<DefaultInitialContext>;
  /**
   * Cross-site state change, refused before dispatch. Defaults to on when any
   * composed scheme reads a cookie — `sessionAuthenticator` is the one that
   * ships — and off otherwise, since a caller presenting a header credential is
   * not a CSRF target. `false` turns it off whatever is composed; `true` turns
   * it on whatever is composed.
   *
   * Not a config field: a deployment that can silently turn it off is the
   * footgun `securityHeaders` is not allowed to be either.
   */
  readonly csrf?: boolean;
  /**
   * Any other oRPC handler plugin. Transport policy configuring the transport;
   * not a middleware slot for application logic, which the package still
   * declines.
   */
  readonly plugins?: readonly NodeHttpHandlerPlugin<DefaultInitialContext>[];
};

/**
 * 1 MiB, the `HTTP_BODY_LIMIT` default. An unbounded body is a trust boundary rather
 * than a convenience, so this one field defaults ON where `HTTP_CORS_ORIGIN` and
 * `HTTP_COMPRESSION` — policy, not safety — default off. An application serving
 * uploads raises it.
 */
export const DEFAULT_BODY_LIMIT = 1_048_576;

/**
 * The CORS options the plugin is built with, or `undefined` for no plugin at
 * all. A record's own `origin` wins over `HTTP_CORS_ORIGIN`, which wins over oRPC's
 * default of reflecting the request's — explicit beats environment beats
 * default, per field. `cors: false` is off whatever the environment says, and
 * `HTTP_CORS_ORIGIN` alone is enough to turn it on.
 */
const corsOf = (
  option: OrpcOptions["cors"],
  corsOrigin: string,
): CORSHandlerPluginOptions<DefaultInitialContext> | undefined => {
  if (option === false) return undefined;
  if (option === undefined && corsOrigin === "") return undefined;
  const record = option === undefined || option === true ? {} : option;
  if (record.origin !== undefined || corsOrigin === "") return record;
  return { ...record, origin: corsOrigin.split(",").map((origin) => origin.trim()) };
};

/** The configured policies, ahead of whatever `plugins` the application added. */
export const pluginsOf = (
  options: OrpcOptions,
  config: ServiceOf<HttpConfig>,
  csrf: boolean,
): readonly NodeHttpHandlerPlugin<DefaultInitialContext>[] => {
  const cors = corsOf(options.cors, config.corsOrigin);
  const compression =
    options.compression === undefined || typeof options.compression === "boolean"
      ? {}
      : options.compression;
  const compressionEnabled =
    options.compression === undefined ? config.compression : options.compression !== false;
  return [
    // The runtime's own check covers the state-changing methods and never sees
    // a GET; this plugin covers the GET oRPC allows for a streaming procedure,
    // which a browser can be navigated to. Disjoint, so nothing is refused twice.
    ...(csrf ? [new GetMethodCsrfProtectionHandlerPlugin()] : []),
    ...(cors === undefined ? [] : [new CORSHandlerPlugin(cors)]),
    ...(config.bodyLimit === 0
      ? []
      : [new RequestLimitHandlerPlugin({ maxBodySize: config.bodyLimit })]),
    ...(compressionEnabled ? [new ResponseCompressionHandlerPlugin(compression)] : []),
    ...(options.plugins ?? []),
  ];
};

/**
 * The router's port — one id, the starter's own, which an application never
 * names. Spelled through `PortClassOf` / `PortInstance` rather than a `class`
 * so a consumer's declaration emit can name the provider's type (TS4023
 * otherwise). Exported for this package's tests, not from `index.ts`.
 */
export const OrpcRouterPort = Port("OrpcRouter") as PortClassOf<
  "OrpcRouter",
  Router<Record<never, never>>
>;
export type OrpcRouterPort = PortInstance<"OrpcRouter", Router<Record<never, never>>>;

/** oRPC's own default set; GET is the one addition, and only where a browser has to send it. */
const RPC_METHODS: ReadonlySet<string> = new Set(RPC_DEFAULT_ALLOW_METHODS);

/** Whether a procedure's declared output is an event iterator — the shape `EventSource` consumes. */
const streamsOutput = (procedure: AnyProcedure): boolean =>
  (procedure["~orpc"].outputSchemas ?? []).some(
    (schema) => getAsyncIteratorObjectSchemaDetails(schema) !== undefined,
  );

/**
 * The oRPC starter: a provider of `HttpHandler` built from the router port,
 * mounted under `prefix`. A request oRPC does not match resolves unwritten and
 * the runtime answers its `404`. Nothing here maps a `Result` to a status.
 */
export const orpc = (options: OrpcOptions = {}) => {
  const prefix = options.prefix ?? "/rpc";
  return Provider.member(HttpHandler)({
    inject: { router: OrpcRouterPort, config: HttpConfig, cookieSchemes: CookieSchemes },
    sync: ({ router, config, cookieSchemes }) => {
      const rpc = new RPCHandler(router, {
        plugins: [...pluginsOf(options, config, csrfOn(options.csrf, cookieSchemes))],
        allowMethods: (method, procedure) =>
          method === "GET" ? streamsOutput(procedure) : RPC_METHODS.has(method),
      });
      return {
        prefix,
        // The request and the unit host both ride oRPC's initial context:
        // `principalMiddleware` reads the former, `unitScope` the latter.
        handle: (request, response, _signal, host) =>
          rpc.handle(request, response, { prefix, context: { request, host } }),
      };
    },
  });
};

/**
 * The router as a provider, from the contract — minted by `defineHttp`, so its
 * handlers are typed by the scheme registry that call inferred.
 *
 * ```ts
 * const orderRouter = api.OrpcRouter(orderContract)({
 *   inject: { place: PlaceOrder },
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
 * `{ inject, sync }` — each an `OrpcController(contract, path)` over one node
 * of the contract tree, at any depth, the paths partitioning the contract's
 * procedures: an uncovered leaf is refused against the
 * `"UNCOVERED CONTROLLERS — …"` marker, a piece nested inside another piece's
 * fragment against `"OVERLAPPING CONTROLLERS — …"`, and a contract whose top
 * level carries a dotted key — which no piece path can encode — against
 * `"UNSLICEABLE CONTRACT KEY — …"`, which points at this form's
 * `{ inject, sync }` arm instead.
 */
export const routerFor =
  <
    Schemes,
    Auth extends AnyProvider = never,
    Vocab = Record<never, never>,
    Units = Record<never, never>,
  >(
    authenticators: readonly Auth[],
    principals: Readonly<Record<string, AnyPort>> = {},
  ) =>
  <C extends Record<string, RouterContract>>(contract: C & ScopeGate<C, Vocab>) => {
    // Walked untyped: `Implementation<C>` is the whole check, and
    // `implement(contract)`'s own type is a per-contract intersection this
    // generic body cannot index into.
    const os = implement(contract) as unknown as Record<string, unknown> & {
      readonly router: (record: Record<string, unknown>) => Router<Record<never, never>>;
    };

    function build<
      const D extends Readonly<Record<string, AnyPort>>,
      const U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
    >(options: {
      readonly inject: D;
      /** The unit-scoped ports every leaf may read off `context.unit`, per its own kind. */
      readonly unit?: U;
      readonly sync: (services: {
        readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
      }) => Implementation<C, Schemes, never, Units, U>;
    }): Built<
      Auth,
      InstanceType<D[keyof D]> | SchemePortsOf<AllRequirementsOf<C>>,
      Units,
      KindsIn<C>
    >;
    // Declared LAST on purpose: TypeScript reports the last overload's
    // failure, so a bad array is refused against the markers below rather than
    // degrading to di's `Qualification`, which names nothing (measured in
    // `packages/amqp-worker`, same mechanism). The marker is a sentence
    // because it is the only actionable part of the diagnostic and it prints
    // last, past the caller's own wide piece type.
    function build<const T extends readonly PieceOf<C, Schemes>[]>(
      pieces: Erroneous<T> extends true
        ? T
        : [Unsliceable<C>] extends [never]
          ? [Uncovered<C, KeyOfPiece<T[number]>>] extends [never]
            ? [Overlapping<KeyOfPiece<T[number]>>] extends [never]
              ? T
              : Refuse<
                  T,
                  "OVERLAPPING CONTROLLERS — a piece sits inside another piece's fragment",
                  Overlapping<KeyOfPiece<T[number]>>
                >
            : Refuse<
                T,
                "UNCOVERED CONTROLLERS — the contract declares a procedure this array does not cover",
                Uncovered<C, KeyOfPiece<T[number]>>
              >
          : Refuse<
              T,
              "UNSLICEABLE CONTRACT KEY — a top-level key contains a dot, which a piece path cannot encode; serve this contract with the { inject, sync } form instead",
              Unsliceable<C>
            >,
    ): Built<
      Auth,
      InstanceType<T[number]["port"]> | SchemePortsOf<AllRequirementsOf<C>>,
      Units,
      KindsIn<C>
    >;
    function build(depsOrPieces: unknown): unknown {
      const schemes = schemesOf(contract);

      // The caller's own deps, plus one per scheme and the router's own
      // `HttpUnit`; `sync` hands the caller back only the keys it declared.
      const provide = (
        deps: Record<string, AnyPort>,
        implementationOf: (own: Record<string, unknown>) => Record<string, unknown>,
        records: ReadonlyMap<string, Readonly<Record<string, AnyPort>>>,
      ): unknown => {
        const sync = (services: Record<string, unknown>): Router<Record<never, never>> => {
          const own = Object.fromEntries(Object.keys(deps).map((key) => [key, services[key]]));
          const authenticated = schemeServices(schemes, services);
          const units = (services[UNIT] as ServiceOf<HttpUnit> | undefined) ?? {};
          // Walks the implementation record next to the implementer and the
          // contract: a function is a procedure, anything else a nested router.
          // `inherited` carries a marked record's requirements down to its
          // procedures, as `Inherit<T, R>` does in the types. `.use` must come
          // BEFORE `.result`: `.result` returns an `ImplementedProcedure`, whose
          // own `.use` has no `.result` left.
          const routerOf = (
            implementer: Record<string, unknown>,
            implementation: Record<string, unknown>,
            node: Record<string, unknown>,
            inherited: Requirements | undefined,
            path: string,
          ): Record<string, unknown> =>
            Object.fromEntries(
              Object.entries(implementation).flatMap(([key, value]) => {
                const target = implementer[key] as ChainableImplementer | undefined;
                if (target === undefined) return [];
                const child = node[key];
                const declared =
                  typeof child === "object" && child !== null ? isAuthenticated(child) : undefined;
                const effective = declared ?? inherited;
                const here = path === "" ? key : `${path}.${key}`;
                if (typeof value !== "function")
                  return [
                    [
                      key,
                      routerOf(
                        target,
                        value as Record<string, unknown>,
                        (child ?? {}) as Record<string, unknown>,
                        effective,
                        here,
                      ),
                    ],
                  ];
                const guarded =
                  effective === undefined
                    ? target
                    : target.use(principalMiddleware(effective, authenticated));
                return [
                  [
                    key,
                    guarded
                      .use(unitScope(units, principals, recordAt(records, here)))
                      .result(value),
                  ],
                ];
              }),
            );
          return os.router(
            routerOf(os, implementationOf(own), contract, isAuthenticated(contract), ""),
          );
        };
        return Object.assign(
          Provider(OrpcRouterPort)({
            inject: { ...deps, ...schemeDeps(schemes), [UNIT]: HttpUnit },
            sync,
          } as never),
          { authenticators },
        );
      };

      // An array is never a valid `Provider(port)` call — its one argument is
      // a record — so `Array.isArray` alone identifies the composing arm.
      if (Array.isArray(depsOrPieces)) {
        const pieces = depsOrPieces as readonly {
          readonly port: AnyPort;
          readonly unit: Readonly<Record<string, AnyPort>>;
        }[];
        // Each piece is declared under the dotted path its port id carries;
        // `nest` folds those paths back into the contract's own tree before
        // the `routerOf` walk.
        const pathOf = (piece: (typeof pieces)[number]): string =>
          piece.port.portId.slice(CONTROLLER_PREFIX.length);
        return provide(
          Object.fromEntries(pieces.map((piece) => [pathOf(piece), piece.port])),
          nest,
          new Map(pieces.map((piece) => [pathOf(piece), piece.unit])),
        );
      }

      const supplied = depsOrPieces as {
        readonly inject: Record<string, AnyPort>;
        readonly unit?: Readonly<Record<string, AnyPort>>;
        readonly sync: (s: Record<string, unknown>) => unknown;
      };
      return provide(
        supplied.inject,
        (own) => supplied.sync(own) as Record<string, unknown>,
        new Map([["", supplied.unit ?? {}]]),
      );
    }

    return build;
  };

// Namespaced so it cannot collide with a key the caller wrote: the router's
// own `HttpUnit` dependency, which the caller's `sync` never sees.
const UNIT = "@btravstack/http-server/unit";

// A piece's dotted path becomes the nesting the contract already has, so
// `routerOf` walks the same tree it always did — marks, inheritance and the
// stray-key drop included. Written here rather than pushed into the walk
// because the walk is shared with the `{ inject, sync }` form, which never nests.
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
 * What a `sync` arm returns: the contract's shape, with a `Result`-returning
 * handler at every procedure — the parameter `@unthrown/orpc`'s `.result()`
 * takes on that procedure's implementer.
 */
// `C` is deliberately unbounded: `controller.ts` instantiates this with the
// deferred `FragmentAt<C, K>`, whose branches TypeScript cannot prove
// `RouterContract` for a generic contract — the mapped arm below already
// guards each child with `C[K] extends RouterContract`.
export type Implementation<
  C,
  Schemes = never,
  R extends Requirements = never,
  Units = Record<never, never>,
  U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
> =
  C extends ProcedureContract<infer I, infer O, infer E>
    ? Parameters<
        ProcedureImplementer<
          DefaultInitialContext & object,
          ContextOf<C, R, Schemes, Units, U>,
          I,
          O,
          E
        >["result"]
      >[0]
    : {
        readonly [K in Exclude<keyof C, PrincipalKey>]: C[K] extends RouterContract
          ? Implementation<C[K], Schemes, Effective<C, R>, Units, U>
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
 *
 * `unit` is the declared `unit:` record narrowed to the kind this leaf's own
 * requirements select, so a port the kind's module cannot provide is absent
 * rather than `undefined`.
 */
type ContextOf<
  C,
  R extends Requirements,
  Schemes,
  Units,
  U extends Readonly<Record<string, AnyPort>>,
> = ([Effective<C, R>] extends [never]
  ? object
  : { readonly principal: Principal<SchemesOf<Effective<C, R>>, Schemes> }) & {
  readonly unit: UnitFor<U, Units, KindOf<Effective<C, R>>>;
};

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
 * One port instance per scheme named anywhere in `R`, a union of requirement
 * tuples — as a router's composed provider's needs channel, fed
 * `AllRequirementsOf<C>`, or `htmx-route.ts`'s, fed `RequiresOfPiece<T[number]>`
 * — each piece's own literal `requires`, distributed over the union rather
 * than folded from a contract. The runtime side is `schemesOf`; these must
 * agree.
 */
export type SchemePortsOf<R> =
  SchemesIn<R> extends infer S extends string
    ? S extends string
      ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
      : never
    : never;

/**
 * Every scheme the contract names, anywhere — the router's scheme
 * dependencies. The type side is `SchemePortsOf<R>`; these two must agree.
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

/**
 * A node of `implement(contract)`'s own tree, as far as the walk uses it:
 * `.use` returns the SAME shape, so two chained calls — `principalMiddleware`
 * then `unitScope` — still carry `.use` and `.result` on the second result.
 */
type ChainableImplementer = Record<string, unknown> & {
  readonly result: (fn: unknown) => unknown;
  readonly use: (middleware: unknown) => ChainableImplementer;
};

/**
 * The `unit:` record in force at `path`: the nearest ancestor piece's, falling
 * back to `""` — the key the `{ inject, sync }` arm registers its one record
 * under, and the root of the array arm, where no piece sits.
 */
const recordAt = (
  records: ReadonlyMap<string, Readonly<Record<string, AnyPort>>>,
  path: string,
): Readonly<Record<string, AnyPort>> => {
  for (let at = path; at !== ""; at = at.slice(0, Math.max(at.lastIndexOf("."), 0))) {
    const found = records.get(at);
    if (found !== undefined) return found;
  }
  return records.get("") ?? {};
};
