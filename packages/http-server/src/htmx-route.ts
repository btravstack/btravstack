import type { OneScheme, Requirements } from "@btravstack/contract";
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
import type { FragmentInputSchema, ParamsOf } from "./fragments.js";
import type { Html } from "./html.js";
import type { ScopesIn, SchemePortsOf, SchemesIn } from "./orpc.js";
import type { Principal, SchemesOf } from "./principal.js";

/** The prefix a piece's port id carries, ahead of its own method and path. */
export const FRAGMENT_PREFIX = "HtmxFragment:";

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

/** What a route's own schema infers, or the raw decoded form when it declares none. */
type InputOfSchema<S extends FragmentInputSchema | undefined> = S extends undefined
  ? Readonly<Record<string, string>>
  : NonNullable<NonNullable<S>["~standard"]["types"]>["output"];

/** What `requires` types on `context.principal` — no contract, so nothing to fold nearest-mark-wins over. */
type PrincipalFromRequires<R extends Requirements, Schemes> = [R] extends [never]
  ? never
  : Principal<SchemesOf<R>, Schemes>;

/** A route's handler: the path's own params next to the decoded input. */
type RouteHandler<P extends `/${string}`, S extends FragmentInputSchema | undefined, Principal> = (
  context: [Principal] extends [never] ? object : { readonly principal: Principal },
  params: ParamsOf<P>,
  input: InputOfSchema<S>,
) => AsyncResult<Html, never>;

/**
 * What `HtmxGet` and `HtmxPost` return. Keyed by `${method} ${path}` — GET and POST on one path
 * are distinct, and two routes on one method+path are one port id, di's
 * duplicate-provider defect. `route.requires` carries the LITERAL `R`, not the
 * widened `Requirements | undefined` — the array arm's needs channel reads it
 * back through `RequiresOfPiece`, and a widened field would make that
 * unrecoverable at the type level.
 */
type MintedRoute<Id extends string, H, R extends Requirements, N> = Provider<
  InstanceType<PortClassOf<Id, H>>,
  never,
  N
> & {
  readonly port: PortClassOf<Id, H>;
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
 * deliberately, rather than one `method`-parameterised generic: `method` here
 * is a plain runtime string, never a type argument.
 *
 * ```ts
 * const orderRow = api.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })({
 *   inject: { repository: OrderRepository },
 *   sync: ({ repository }) => (context, params) => repository.find(params.id).map(rowOf),
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
    (options: unknown): unknown => {
      // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
      const port = class extends Port(`${FRAGMENT_PREFIX}${method} ${path}`)<
        (context: unknown, params: unknown, input: unknown) => AsyncResult<Html, never>
      > {};
      const provider = Provider(port as never)(options as never);
      return Object.assign(provider, { route: { method, path, input, requires } });
    };

  const HtmxGet = <
    const P extends `/${string}`,
    const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> } = never,
  >(
    path: P,
    options?: { readonly requires?: R & RequiresGate<R, Vocab> },
  ): {
    <const D extends Readonly<Record<string, AnyPort>>>(buildOptions: {
      readonly inject: D;
      readonly sync: (services: {
        readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
      }) => RouteHandler<P, undefined, PrincipalFromRequires<R, Schemes>>;
    }): MintedRoute<
      `${typeof FRAGMENT_PREFIX}GET ${P}`,
      RouteHandler<P, undefined, PrincipalFromRequires<R, Schemes>>,
      R,
      InstanceType<D[keyof D]>
    >;
  } => mint("GET", path, undefined, options?.requires as Requirements | undefined) as never;

  const HtmxPost = <
    const P extends `/${string}`,
    const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> } = never,
    const S extends FragmentInputSchema | undefined = undefined,
  >(
    path: P,
    options?: { readonly requires?: R & RequiresGate<R, Vocab>; readonly input?: S },
  ): {
    <const D extends Readonly<Record<string, AnyPort>>>(buildOptions: {
      readonly inject: D;
      readonly sync: (services: {
        readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
      }) => RouteHandler<P, S, PrincipalFromRequires<R, Schemes>>;
    }): MintedRoute<
      `${typeof FRAGMENT_PREFIX}POST ${P}`,
      RouteHandler<P, S, PrincipalFromRequires<R, Schemes>>,
      R,
      InstanceType<D[keyof D]>
    >;
  } => mint("POST", path, options?.input, options?.requires as Requirements | undefined) as never;

  return { HtmxGet, HtmxPost };
};

/** What the answerer reads back for one route, principal and body erased to `unknown`. */
export type FragmentAnswer = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly input: FragmentInputSchema | undefined;
  readonly requirements: Requirements | undefined;
  readonly handle: (
    principal: unknown,
    params: Readonly<Record<string, string>>,
    input: unknown,
  ) => AsyncResult<Html, never>;
};

/**
 * Every route a fragment declares, composed into one port — the answerer's
 * own reads it through `routes` and calls `resolvePrincipal` itself, which is
 * why `requirements` and `authenticators` ride the port rather than staying
 * in this closure.
 */
export class HtmxFragmentsPort extends Port("HtmxFragments")<{
  readonly routes: readonly FragmentAnswer[];
  readonly authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>;
}> {}

// Namespaced so a scheme's key cannot collide with a route name the caller wrote.
const AUTHENTICATOR = "@btravstack/http-server/fragment-authenticator:";

/**
 * Every scheme any route's `requires` names, walked directly over the raw
 * data — a route's `requires` is `Requirements` data, read straight off
 * `piece.route`, never a marker `isAuthenticated` could resolve.
 */
const schemesInRoutes = (routes: readonly AnyRoutePiece[]): readonly string[] => {
  const found = new Set<string>();
  for (const piece of routes)
    for (const requirement of piece.route.requires ?? [])
      for (const scheme of Object.keys(requirement)) found.add(scheme);
  return [...found];
};

/**
 * `HtmxFragments`: every route composed from an array of `HtmxGet`/`HtmxPost`
 * pieces into one port. Keyed by INDEX rather than by the piece's own port
 * id: two pieces sharing one method+path share one port id, and keying
 * `deps` by that id would silently keep only the last, hiding the very
 * collision di's duplicate-provider defect exists to catch.
 */
export const htmxFragmentsFor =
  <Auth extends AnyProvider = never>(authenticators: readonly Auth[]) =>
  <const T extends readonly AnyRoutePiece[]>(
    routes: T,
  ): Provider<
    InstanceType<typeof HtmxFragmentsPort>,
    never,
    InstanceType<T[number]["port"]> | SchemePortsOf<RequiresOfPiece<T[number]>>
  > & {
    readonly authenticators: readonly Auth[];
  } => {
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
      routes: routes.map((piece, index) => ({
        method: piece.route.method,
        path: piece.route.path,
        input: piece.route.input,
        requirements: piece.route.requires,
        handle: toAnswer(services[`route:${index}`]),
      })),
      authenticators: Object.fromEntries(
        schemes.map((scheme) => [scheme, services[`${AUTHENTICATOR}${scheme}`]]),
      ) as Readonly<Record<string, AuthenticatorService<unknown>>>,
    });
    return Object.assign(Provider(HtmxFragmentsPort)({ inject: deps, sync } as never), {
      authenticators,
    }) as never;
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
