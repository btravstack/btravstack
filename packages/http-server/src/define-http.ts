import { Provider, type AnyProvider, type PortClassOf, type PortInstance } from "@btravstack/di";

import {
  authenticatorPort,
  principalPort,
  type Authenticator,
  type AuthenticatorService,
} from "./auth.js";
import { controllerFor } from "./controller.js";
import { htmxFragmentsFor, htmxRouteFor } from "./htmx-route.js";
import { routerFor } from "./orpc.js";
import type { Kinds, UnitsOf } from "./unit.js";

/** The authenticators an application declares, keyed by scheme name. */
export type Authenticators = Readonly<Record<string, Authenticator<unknown, string, unknown>>>;

/** The scheme registry, read off the authenticators rather than declared twice. */
export type SchemesFrom<A extends Authenticators> = { readonly [K in keyof A]: A[K]["principal"] };

/**
 * What each scheme can grant, read off the same authenticators. Separate from
 * `SchemesFrom` because they answer different questions at different call
 * sites: the principal types the handler, the vocabulary checks the contract.
 */
export type VocabFrom<A extends Authenticators> = { readonly [K in keyof A]: A[K]["scope"] };

/**
 * One di provider per scheme, on the port whose id carries that scheme's name,
 * and carrying that authenticator's own dependencies in its needs channel — so
 * an authenticator that reads a `JwtVerifier` still owes it where `HttpModule`
 * puts it in `provides`.
 */
type SchemeProviders<A extends Authenticators> = {
  readonly [K in keyof A]: Provider<
    PortInstance<`HttpAuthenticator:${K & string}`, AuthenticatorService<unknown>>,
    never,
    A[K]["needs"]
  >;
}[keyof A];

/**
 * Everything an application mints from one call. Held as ONE binding and never
 * destructured: each binding of a destructured member expands to a type
 * mentioning `@btravstack/contract`'s inaccessible `unique symbol`, which is
 * TS2527 (measured). Held whole, the inferred type collapses to `Http<A>`,
 * which is nameable — so an application writes no annotation at all.
 */
export type Http<A extends Authenticators, Units extends UnitsOf<A> = Record<never, never>> = {
  readonly OrpcController: ReturnType<typeof controllerFor<SchemesFrom<A>, Units>>;
  readonly OrpcRouter: ReturnType<
    typeof routerFor<SchemesFrom<A>, SchemeProviders<A>, VocabFrom<A>, Units>
  >;
  readonly HtmxFragments: ReturnType<typeof htmxFragmentsFor<SchemeProviders<A>, Units>>;
  readonly HtmxGet: ReturnType<typeof htmxRouteFor<SchemesFrom<A>, VocabFrom<A>, Units>>["HtmxGet"];
  readonly HtmxPost: ReturnType<
    typeof htmxRouteFor<SchemesFrom<A>, VocabFrom<A>, Units>
  >["HtmxPost"];
  /**
   * The declarations as given, for a hand-rolled composition or a custom sugar
   * that reads the registry off them the way `defineHttp` does. No in-repo
   * example needs it — `HttpModule` carries the bound providers on the router.
   */
  readonly authenticators: A;
  /**
   * One port per scheme carrying that scheme's principal, for a unit module to
   * name in `needs` and inject.
   */
  readonly principals: Principals<A>;
  /**
   * The second step: the SAME object, retyped by the module each kind binds.
   * A kind the authenticators never declared is refused here — the mapped arm
   * demands `never` for every key outside `Kinds<A>`, which a real module can
   * never satisfy, and it names that key in the diagnostic.
   */
  readonly units: <
    U extends UnitsOf<A> & { readonly [K in Exclude<keyof U, Kinds<A>>]: never },
  >() => Http<A, U>;
  /** Phantom: `Units` is read by the piece factories' leaf typing, never at runtime. */
  readonly _units?: Units;
};

/** One port per scheme, typed by the principal that scheme's authenticator declared. */
export type Principals<A extends Authenticators> = {
  readonly [K in keyof A & string]: PortClassOf<`HttpPrincipal:${K}`, A[K]["principal"]>;
};

/**
 * The one door to the marker-typed entities. Declaring a scheme and
 * implementing it are the same act, so a scheme without an authenticator is
 * not a state this can reach — there is no coverage gate because there is
 * nothing to forget.
 *
 * ```ts
 * export const api = defineHttp({ authenticators: { user: userAuth } });
 * export const api = defineHttp();   // a public API: `principal` is `never`
 * ```
 *
 * The default registry is `Record<never, never>`, not `Record<string, never>`:
 * an index signature over `string` would make EVERY scheme's port look
 * available to di, so a marked contract composed under `defineHttp()` would
 * type-check and then fail at build. Empty, the port stays unmet and the
 * composition is refused.
 */
export const defineHttp = <const A extends Authenticators = Record<never, never>>(options?: {
  readonly authenticators: A;
}): Http<A> => {
  const declared: Authenticators = options?.authenticators ?? {};
  const providers = Object.entries(declared).map(([scheme, authenticator]) =>
    bind(scheme, authenticator),
  );
  const routes = htmxRouteFor<SchemesFrom<A>, VocabFrom<A>>();
  const principals = Object.fromEntries(
    Object.keys(declared).map((scheme) => [scheme, principalPort(scheme)]),
  );
  const http: Http<A> = {
    OrpcController: controllerFor<SchemesFrom<A>>(),
    OrpcRouter: routerFor<SchemesFrom<A>, SchemeProviders<A>, VocabFrom<A>>(
      providers as never,
      principals,
    ),
    HtmxFragments: htmxFragmentsFor<SchemeProviders<A>>(providers as never, principals),
    HtmxGet: routes.HtmxGet,
    HtmxPost: routes.HtmxPost,
    authenticators: declared as A,
    principals: principals as Principals<A>,
    units: () => http as never,
  };
  return http;
};

/** The description `HttpAuthenticator` held, bound now that the scheme NAME exists to mint a port from. */
const bind = (
  scheme: string,
  authenticator: Authenticator<unknown, string, unknown>,
): AnyProvider => Provider(authenticatorPort(scheme) as never)(authenticator.options as never);
