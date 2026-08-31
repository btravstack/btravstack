import { isAuthenticated, type Requirements, type RequirementsOf } from "@btravstack/contract";
import {
  Port,
  Provider,
  type AnyPort,
  type AnyProvider,
  type PortClassOf,
  type ServiceOf,
} from "@btravstack/di";
import type { AsyncResult } from "unthrown";

import { authenticatorPort, type AuthenticatorService } from "./auth.js";
import type {
  FragmentInputSchema,
  FragmentRoute,
  FragmentsContract,
  ParamsOf,
} from "./fragments.js";
import type { Html } from "./html.js";
import {
  schemesOf,
  type Effective,
  type ScopesIn,
  type SchemePortsOf,
  type SchemesIn,
} from "./orpc.js";
import type { Principal, SchemesOf } from "./principal.js";

/** The prefix a piece's port id carries; the composing form strips it to recover the key. */
export const FRAGMENT_PREFIX = "HtmxFragment:";

/**
 * What a route's own schema infers, or the raw decoded form when it declares
 * none. `~standard.types` is never populated at runtime — it exists on the
 * TYPE `Config.object` returns, purely for this extraction.
 */
type InputOf<R extends FragmentRoute> = R["input"] extends undefined
  ? Readonly<Record<string, string>>
  : NonNullable<NonNullable<R["input"]>["~standard"]["types"]>["output"];

/**
 * A fragment's handler: a route's path parameters and its decoded input, next
 * to the principal its effective requirements type. Where neither the route
 * nor the contract is marked, `Principal` is `never` and `context` is bare
 * `object` — not `{ principal: never }`, which would type-check a read but,
 * worse, would let a marked piece's handler (contravariantly narrower) satisfy
 * an unmarked slot's type, since `never` is assignable to anything. `object`
 * has no `principal` property at all, so a bare read is refused outright —
 * mirroring `orpc.ts`'s `ContextOf`. The composition refusal itself holds for
 * a ROUTE-level mark; a CONTRACT-level mark is not refused here today. The
 * error channel is `never` deliberately: triage is the slice's own, at the
 * same place the oRPC controller's `mapErrCases` sits.
 */
export type FragmentHandler<R extends FragmentRoute, Principal> = (
  context: [Principal] extends [never] ? object : { readonly principal: Principal },
  params: ParamsOf<R["path"]>,
  input: InputOf<R>,
) => AsyncResult<Html, never>;

/** Nearest mark wins: a route's own, else the contract's. */
type EffectiveOf<F extends FragmentsContract, K extends keyof F & string> = Effective<
  F[K],
  Effective<F, never>
>;

/** What a route's handler reads on `context.principal`, folded from `EffectiveOf`. */
type PrincipalOf<F extends FragmentsContract, K extends keyof F & string, Schemes> = [
  EffectiveOf<F, K>,
] extends [never]
  ? never
  : Principal<SchemesOf<EffectiveOf<F, K>>, Schemes>;

/**
 * Every requirement the fragment contract carries, anywhere — its own mark
 * and every route's. Flat, unlike `orpc.ts`'s recursive `AllRequirementsOf`:
 * a fragment contract is one level of routes, not a tree, so this is the one
 * piece that cannot be shared between the two files — `SchemesIn` and
 * `SchemePortsOf`, both fed by this, are imported from `orpc.ts` instead.
 */
type AllRequirementsOf<F extends FragmentsContract> =
  | RequirementsOf<F>
  | { readonly [K in keyof F & string]: RequirementsOf<F[K]> }[keyof F & string];

/** The port one route targets. */
type FragmentPortOf<
  F extends FragmentsContract,
  K extends keyof F & string,
  Schemes = never,
> = PortClassOf<`${typeof FRAGMENT_PREFIX}${K}`, FragmentHandler<F[K], PrincipalOf<F, K, Schemes>>>;

/** What both arms of a minted piece return; `N` is the only thing that differs. */
type Minted<F extends FragmentsContract, K extends keyof F & string, Schemes, N> = Provider<
  InstanceType<FragmentPortOf<F, K, Schemes>>,
  never,
  N
> & {
  readonly port: FragmentPortOf<F, K, Schemes>;
};

/**
 * One route of a fragment contract, as a provider on a port of its own. The
 * key space is flat — unlike `HttpController`'s dotted contract tree — so there
 * is no unsliceable or overlapping key to refuse: two pieces claiming one
 * route are simply di's duplicate-provider defect, via the port id every piece
 * carries.
 *
 * ```ts
 * const orderRow = api.HtmxController(fragments, "orderRow")({
 *   sync: () => (context, params) => repository.find(params.id).map(rowOf),
 * });
 * ```
 */
export const htmxControllerFor =
  <Schemes>() =>
  <const F extends FragmentsContract, const K extends keyof F & string>(fragments: F, key: K) => {
    // Named rather than `_`-prefixed so it reads as `fragments` in the
    // published `.d.ts`; nothing needs its value — it fixes `F` by inference.
    void fragments;
    // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
    const port = class extends Port(`${FRAGMENT_PREFIX}${key}`)<
      FragmentHandler<F[K], PrincipalOf<F, K, Schemes>>
    > {};

    // Two arms discriminated by ARITY, mirroring `Provider(port)`'s own.
    function build<const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      options: {
        readonly sync: (services: {
          readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
        }) => FragmentHandler<F[K], PrincipalOf<F, K, Schemes>>;
      },
    ): Minted<F, K, Schemes, InstanceType<D[keyof D]>>;
    function build(options: {
      readonly sync: () => FragmentHandler<F[K], PrincipalOf<F, K, Schemes>>;
    }): Minted<F, K, Schemes, never>;
    function build(depsOrOptions: unknown, options?: unknown): unknown {
      return options === undefined
        ? Provider(port as never)(depsOrOptions as never)
        : Provider(port as never)(depsOrOptions as never, options as never);
    }
    return build;
  };

/** Every scope string `R` names for scheme `K` — `orpc.ts`'s `ScopesIn`, fed directly since `requires` already IS a requirements union, not a tree to walk. */
type UngrantableIn<R, Vocab> = {
  [K in SchemesIn<R>]: K extends keyof Vocab ? Exclude<ScopesIn<R, K>, Vocab[K]> : never;
}[SchemesIn<R>];

/**
 * `orpc.ts`'s `ScopeGate` with the contract fold removed: `requires` is data,
 * not a tree, so there is nothing to walk before checking it.
 */
type RequiresGate<R, Vocab> = [UngrantableIn<R, Vocab>] extends [never]
  ? unknown
  : {
      readonly "UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it": UngrantableIn<
        R,
        Vocab
      >;
    };

/** What a route's own schema infers, or the raw decoded form when it declares none — `InputOf`, reparameterised over the schema rather than a route type. */
type InputOfSchema<S extends FragmentInputSchema | undefined> = S extends undefined
  ? Readonly<Record<string, string>>
  : NonNullable<NonNullable<S>["~standard"]["types"]>["output"];

/** What `requires` types on `context.principal` — no contract, so nothing to fold nearest-mark-wins over. */
type PrincipalFromRequires<R extends Requirements, Schemes> = [R] extends [never]
  ? never
  : Principal<SchemesOf<R>, Schemes>;

/** A route-first handler: the path's own params next to the decoded input. */
type RouteHandler<P extends `/${string}`, S extends FragmentInputSchema | undefined, Principal> = (
  context: [Principal] extends [never] ? object : { readonly principal: Principal },
  params: ParamsOf<P>,
  input: InputOfSchema<S>,
) => AsyncResult<Html, never>;

/** The port one route mints, keyed by `${method} ${path}` — GET and POST on one path are distinct, and two routes on one method+path are one port id, di's duplicate-provider defect. */
type RoutePortOf<Id extends string, H> = PortClassOf<Id, H>;

/**
 * What both `HtmxGet` and `HtmxPost`'s two-arm `build` return; `N` is the only
 * thing that differs. `route.requires` carries the LITERAL `R`, not the
 * widened `Requirements | undefined` — the array arm's needs channel reads it
 * back through `RequiresOfPiece`, and a widened field would make that
 * unrecoverable at the type level.
 */
type MintedRoute<Id extends string, H, R extends Requirements, N> = Provider<
  InstanceType<RoutePortOf<Id, H>>,
  never,
  N
> & {
  readonly port: RoutePortOf<Id, H>;
  readonly route: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly input: FragmentInputSchema | undefined;
    readonly requires: [R] extends [never] ? undefined : R;
  };
};

/** One piece the array arm of `HtmxFragments` accepts — what `HtmxGet`/`HtmxPost` return. */
type AnyRoutePiece = {
  readonly port: AnyPort;
  readonly route: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly input: FragmentInputSchema | undefined;
    readonly requires: Requirements | undefined;
  };
};

/**
 * A piece's own `requires`, read back off its literal type — `never` for a
 * piece minted with none. `P` is a naked type parameter, so applied to a
 * UNION of pieces (`T[number]`) this distributes, one arm per piece, which is
 * what lets `SchemePortsOf` below see every route's own scheme rather than
 * one collapsed answer.
 */
type RequiresOfPiece<P> = P extends {
  readonly route: { readonly requires: infer R extends Requirements };
}
  ? R
  : never;

/**
 * `HtmxGet` and `HtmxPost`: a route as a provider on a port of its own, minted
 * straight from a path — no contract in between. Two separate functions,
 * deliberately, rather than one `method`-parameterised generic: a discriminated
 * union threaded through a generic that feeds a gate has already disabled one
 * silently on this exact surface (`FragmentRoute`, see `fragments.ts`'s own
 * TSDoc), so `method` here is a plain runtime string, never a type argument.
 *
 * ```ts
 * const orderRow = api.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })({
 *   sync: () => (context, params) => repository.find(params.id).map(rowOf),
 * });
 * ```
 */
export const htmxRouteFor = <Schemes, Vocab>() => {
  const mint =
    (
      method: "GET" | "POST",
      path: string,
      input: FragmentInputSchema | undefined,
      requires: Requirements | undefined,
    ) =>
    (depsOrOptions: unknown, options?: unknown): unknown => {
      // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
      const port = class extends Port(`${FRAGMENT_PREFIX}${method} ${path}`)<
        (context: unknown, params: unknown, input: unknown) => AsyncResult<Html, never>
      > {};
      const provider =
        options === undefined
          ? Provider(port as never)(depsOrOptions as never)
          : Provider(port as never)(depsOrOptions as never, options as never);
      return Object.assign(provider, { route: { method, path, input, requires } });
    };

  const HtmxGet = <const P extends `/${string}`, const R extends Requirements = never>(
    path: P,
    options?: { readonly requires?: R & RequiresGate<R, Vocab> },
  ): {
    <const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      buildOptions: {
        readonly sync: (services: {
          readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
        }) => RouteHandler<P, undefined, PrincipalFromRequires<R, Schemes>>;
      },
    ): MintedRoute<
      `${typeof FRAGMENT_PREFIX}GET ${P}`,
      RouteHandler<P, undefined, PrincipalFromRequires<R, Schemes>>,
      R,
      InstanceType<D[keyof D]>
    >;
    (buildOptions: {
      readonly sync: () => RouteHandler<P, undefined, PrincipalFromRequires<R, Schemes>>;
    }): MintedRoute<
      `${typeof FRAGMENT_PREFIX}GET ${P}`,
      RouteHandler<P, undefined, PrincipalFromRequires<R, Schemes>>,
      R,
      never
    >;
  } => mint("GET", path, undefined, options?.requires as Requirements | undefined) as never;

  const HtmxPost = <
    const P extends `/${string}`,
    const R extends Requirements = never,
    const S extends FragmentInputSchema | undefined = undefined,
  >(
    path: P,
    options?: { readonly requires?: R & RequiresGate<R, Vocab>; readonly input?: S },
  ): {
    <const D extends Readonly<Record<string, AnyPort>>>(
      deps: D,
      buildOptions: {
        readonly sync: (services: {
          readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
        }) => RouteHandler<P, S, PrincipalFromRequires<R, Schemes>>;
      },
    ): MintedRoute<
      `${typeof FRAGMENT_PREFIX}POST ${P}`,
      RouteHandler<P, S, PrincipalFromRequires<R, Schemes>>,
      R,
      InstanceType<D[keyof D]>
    >;
    (buildOptions: {
      readonly sync: () => RouteHandler<P, S, PrincipalFromRequires<R, Schemes>>;
    }): MintedRoute<
      `${typeof FRAGMENT_PREFIX}POST ${P}`,
      RouteHandler<P, S, PrincipalFromRequires<R, Schemes>>,
      R,
      never
    >;
  } => mint("POST", path, options?.input, options?.requires as Requirements | undefined) as never;

  return { HtmxGet, HtmxPost };
};

/** What the answerer reads back for one route, principal and body erased to `unknown`. */
export type FragmentAnswer = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly input: FragmentRoute["input"];
  readonly requirements: Requirements | undefined;
  readonly handle: (
    principal: unknown,
    params: Readonly<Record<string, string>>,
    input: unknown,
  ) => AsyncResult<Html, never>;
};

/**
 * Every route a fragment contract declares, composed into one port — the
 * answerer's own reads it through `routes` and calls `resolvePrincipal` itself,
 * which is why `requirements` and `authenticators` ride the port rather than
 * staying in this closure.
 */
export class HtmxFragmentsPort extends Port("HtmxFragments")<{
  readonly routes: readonly FragmentAnswer[];
  readonly authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>;
}> {}

// Namespaced so a scheme's key cannot collide with a route name the caller wrote.
const AUTHENTICATOR = "@btravstack/http-server/fragment-authenticator:";

/** The routes no piece in the array covers. */
type Uncovered<F extends FragmentsContract, Keys extends string> = Exclude<keyof F & string, Keys>;

/** One piece of the fragments port — what `HtmxController(fragments, key)(…)` returns. */
type PieceOf<F extends FragmentsContract, Schemes> = {
  readonly [K in keyof F & string]: {
    readonly port: {
      readonly portId: `${typeof FRAGMENT_PREFIX}${K}`;
      new (): InstanceType<FragmentPortOf<F, K, Schemes>>;
    };
  };
}[keyof F & string];

/** The key a piece carries, read back off its port id. */
type KeyOfPiece<P> = P extends {
  readonly port: { readonly portId: `${typeof FRAGMENT_PREFIX}${infer K}` };
}
  ? K
  : never;

/**
 * Every scheme any route's `requires` names, walked directly over the raw
 * data — `schemesOf` cannot be reused here, since it finds a scheme only
 * through `isAuthenticated`'s marker registry, and route-first `requires` is
 * never marked (it is `Requirements` data, read straight off `piece.route`).
 */
const schemesInRoutes = (routes: readonly AnyRoutePiece[]): readonly string[] => {
  const found = new Set<string>();
  for (const piece of routes)
    for (const requirement of piece.route.requires ?? [])
      for (const scheme of Object.keys(requirement)) found.add(scheme);
  return [...found];
};

/**
 * Every route composed from an array of route pieces — each an
 * `HtmxGet`/`HtmxPost`. Keyed by INDEX rather than by the piece's own port id:
 * two pieces sharing one method+path share one port id, and keying `deps` by
 * that id would silently keep only the last, hiding the very collision di's
 * duplicate-provider defect exists to catch.
 */
const htmxRoutesFor =
  <Auth extends AnyProvider>(authenticators: readonly Auth[]) =>
  (routes: readonly AnyRoutePiece[]): unknown => {
    const routeEntries = routes.map((piece, index) => [`route:${index}`, piece.port] as const);
    const schemes = schemesInRoutes(routes);
    const deps: Record<string, AnyPort> = {
      ...Object.fromEntries(routeEntries),
      ...Object.fromEntries(
        schemes.map((scheme) => [`${AUTHENTICATOR}${scheme}`, authenticatorPort(scheme)]),
      ),
    };
    const sync = (
      services: Record<string, unknown>,
    ): ServiceOf<InstanceType<typeof HtmxFragmentsPort>> => ({
      routes: routeEntries.map(([key], index) => {
        const piece = routes[index] as AnyRoutePiece;
        return {
          method: piece.route.method,
          path: piece.route.path,
          input: piece.route.input,
          requirements: piece.route.requires,
          handle: toAnswer(services[key]),
        };
      }),
      authenticators: Object.fromEntries(
        schemes.map((scheme) => [scheme, services[`${AUTHENTICATOR}${scheme}`]]),
      ) as Readonly<Record<string, AuthenticatorService<unknown>>>,
    });
    return Object.assign(Provider(HtmxFragmentsPort)(deps, { sync } as never), { authenticators });
  };

/**
 * Every route composed into one port — either straight from an array of
 * `HtmxGet`/`HtmxPost` pieces (the route-first arm, `Array.isArray`d), or, for
 * a `FragmentsContract`, curried over an array of
 * `HtmxController(fragments, key)(…)` pieces exactly as before. An uncovered
 * route in the contract form is refused against the `"UNCOVERED FRAGMENTS —
 * …"` marker.
 */
export const htmxFragmentsFor = <Schemes, Auth extends AnyProvider = never>(
  authenticators: readonly Auth[],
) => {
  function HtmxFragments<const T extends readonly AnyRoutePiece[]>(
    routes: T,
  ): Provider<
    InstanceType<typeof HtmxFragmentsPort>,
    never,
    InstanceType<T[number]["port"]> | SchemePortsOf<RequiresOfPiece<T[number]>>
  > & {
    readonly authenticators: readonly Auth[];
  };
  function HtmxFragments<const F extends FragmentsContract>(
    fragments: F,
  ): <const T extends readonly PieceOf<F, Schemes>[]>(
    pieces: [Uncovered<F, KeyOfPiece<T[number]>>] extends [never]
      ? T
      : readonly [
          "UNCOVERED FRAGMENTS — the contract declares a route this array does not cover",
          Uncovered<F, KeyOfPiece<T[number]>>,
        ],
  ) => Provider<
    InstanceType<typeof HtmxFragmentsPort>,
    never,
    InstanceType<T[number]["port"]> | SchemePortsOf<AllRequirementsOf<F>>
  > & { readonly authenticators: readonly Auth[] };
  function HtmxFragments(fragmentsOrRoutes: unknown): unknown {
    // A single array argument is never a valid `FragmentsContract` — the
    // curried form's own argument is always a record — so `Array.isArray`
    // alone tells the two arms apart.
    if (Array.isArray(fragmentsOrRoutes)) {
      return htmxRoutesFor(authenticators)(fragmentsOrRoutes as readonly AnyRoutePiece[]);
    }
    const fragments = fragmentsOrRoutes as FragmentsContract;
    const schemes = schemesOf(fragments);
    const contractRequirements = isAuthenticated(fragments as object);

    function build(pieces: unknown): unknown {
      const list = pieces as readonly { readonly port: AnyPort }[];
      const routeEntries = list.map(
        (piece) => [piece.port.portId.slice(FRAGMENT_PREFIX.length), piece.port] as const,
      );
      // The array's own order, not `Object.keys` order: JS reorders an
      // integer-like string key ("404") ahead of every other key, which would
      // silently reorder a security-relevant route past its neighbours (see
      // `htmx.ts`'s own TSDoc on first-match-wins).
      const keys = routeEntries.map(([key]) => key);
      const deps: Record<string, AnyPort> = {
        ...Object.fromEntries(routeEntries),
        ...Object.fromEntries(
          schemes.map((scheme) => [`${AUTHENTICATOR}${scheme}`, authenticatorPort(scheme)]),
        ),
      };
      const sync = (
        services: Record<string, unknown>,
      ): ServiceOf<InstanceType<typeof HtmxFragmentsPort>> => ({
        routes: keys.map((key) => {
          // Asserted, not guarded: the composing call is typed so every
          // remaining service key is a route this contract declares.
          const route = (fragments as Record<string, unknown>)[key] as FragmentRoute;
          return {
            method: route.method,
            path: route.path,
            input: route.input,
            requirements: isAuthenticated(route as object) ?? contractRequirements,
            handle: toAnswer(services[key]),
          };
        }),
        authenticators: Object.fromEntries(
          schemes.map((scheme) => [scheme, services[`${AUTHENTICATOR}${scheme}`]]),
        ) as Readonly<Record<string, AuthenticatorService<unknown>>>,
      });
      return Object.assign(Provider(HtmxFragmentsPort)(deps, { sync } as never), {
        authenticators,
      });
    }
    return build;
  }
  return HtmxFragments;
};

const toAnswer =
  (handler: unknown): FragmentAnswer["handle"] =>
  (principal, params, input) =>
    (
      handler as (
        context: { readonly principal: unknown },
        params: Readonly<Record<string, string>>,
        input: unknown,
      ) => AsyncResult<Html, never>
    )({ principal }, params, input);
