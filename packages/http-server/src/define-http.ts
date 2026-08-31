import { Provider, type AnyProvider, type PortInstance } from "@btravstack/di";

import { authenticatorPort, type Authenticator, type AuthenticatorService } from "./auth.js";
import { controllerFor } from "./controller.js";
import { htmxControllerFor, htmxFragmentsFor, htmxRouteFor } from "./htmx-controller.js";
import { routerFor } from "./orpc.js";

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
export type Http<A extends Authenticators> = {
  readonly HttpController: ReturnType<typeof controllerFor<SchemesFrom<A>>>;
  readonly HttpRouter: ReturnType<
    typeof routerFor<SchemesFrom<A>, SchemeProviders<A>, VocabFrom<A>>
  >;
  readonly HtmxController: ReturnType<typeof htmxControllerFor<SchemesFrom<A>>>;
  readonly HtmxFragments: ReturnType<typeof htmxFragmentsFor<SchemesFrom<A>, SchemeProviders<A>>>;
  readonly HtmxGet: ReturnType<typeof htmxRouteFor<SchemesFrom<A>, VocabFrom<A>>>["HtmxGet"];
  readonly HtmxPost: ReturnType<typeof htmxRouteFor<SchemesFrom<A>, VocabFrom<A>>>["HtmxPost"];
  /**
   * The declarations as given, for a hand-rolled composition or a custom sugar
   * that reads the registry off them the way `defineHttp` does. No in-repo
   * example needs it — `HttpModule` carries the bound providers on the router.
   */
  readonly authenticators: A;
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
  return {
    HttpController: controllerFor<SchemesFrom<A>>(),
    HttpRouter: routerFor<SchemesFrom<A>, SchemeProviders<A>, VocabFrom<A>>(providers as never),
    HtmxController: htmxControllerFor<SchemesFrom<A>>(),
    HtmxFragments: htmxFragmentsFor<SchemesFrom<A>, SchemeProviders<A>>(providers as never),
    HtmxGet: routes.HtmxGet,
    HtmxPost: routes.HtmxPost,
    authenticators: declared as A,
  };
};

/**
 * `HttpAuthenticator`'s no-deps arm puts its single argument in `deps` and
 * leaves `options` undefined — `Provider(port)`'s own arity discrimination,
 * replayed here now that the scheme NAME exists to mint a port from.
 */
const bind = (
  scheme: string,
  authenticator: Authenticator<unknown, string, unknown>,
): AnyProvider => {
  const port = authenticatorPort(scheme);
  return authenticator.options === undefined
    ? Provider(port as never)(authenticator.deps as never)
    : Provider(port as never)(authenticator.deps as never, authenticator.options as never);
};
