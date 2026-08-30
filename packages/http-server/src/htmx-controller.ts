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
import type { FragmentRoute, FragmentsContract, ParamsOf } from "./fragments.js";
import type { Html } from "./html.js";
import { schemesOf, type Effective, type SchemePortsOf } from "./orpc.js";
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
 * has no `principal` property at all, so both holes close at once — mirroring
 * `orpc.ts`'s `ContextOf`. The error channel is `never` deliberately: triage
 * is the slice's own, at the same place the oRPC controller's `mapErrCases`
 * sits.
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
 * Every route a fragment contract declares, composed from an array of pieces —
 * each an `HtmxController(fragments, key)(…)`. An uncovered route is refused
 * against the `"UNCOVERED FRAGMENTS — …"` marker.
 */
export const htmxFragmentsFor =
  <Schemes, Auth extends AnyProvider = never>(authenticators: readonly Auth[]) =>
  <const F extends FragmentsContract>(fragments: F) => {
    const schemes = schemesOf(fragments);
    const contractRequirements = isAuthenticated(fragments as object);

    function build<const T extends readonly PieceOf<F, Schemes>[]>(
      pieces: [Uncovered<F, KeyOfPiece<T[number]>>] extends [never]
        ? T
        : readonly [
            "UNCOVERED FRAGMENTS — the contract declares a route this array does not cover",
            Uncovered<F, KeyOfPiece<T[number]>>,
          ],
    ): Provider<
      InstanceType<typeof HtmxFragmentsPort>,
      never,
      InstanceType<T[number]["port"]> | SchemePortsOf<AllRequirementsOf<F>>
    > & { readonly authenticators: readonly Auth[] };
    function build(pieces: unknown): unknown {
      const list = pieces as readonly { readonly port: AnyPort }[];
      const deps: Record<string, AnyPort> = {
        ...Object.fromEntries(
          list.map((piece) => [piece.port.portId.slice(FRAGMENT_PREFIX.length), piece.port]),
        ),
        ...Object.fromEntries(
          schemes.map((scheme) => [`${AUTHENTICATOR}${scheme}`, authenticatorPort(scheme)]),
        ),
      };
      const sync = (
        services: Record<string, unknown>,
      ): ServiceOf<InstanceType<typeof HtmxFragmentsPort>> => ({
        routes: Object.entries(services)
          .filter(([key]) => !key.startsWith(AUTHENTICATOR))
          .map(([key, handler]) => {
            // Asserted, not guarded: the composing call is typed so every
            // remaining service key is a route this contract declares.
            const route = (fragments as Record<string, unknown>)[key] as FragmentRoute;
            return {
              method: route.method,
              path: route.path,
              input: route.input,
              requirements: isAuthenticated(route as object) ?? contractRequirements,
              handle: toAnswer(handler),
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
