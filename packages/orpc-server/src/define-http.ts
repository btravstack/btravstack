import { htmxFragmentsFor, htmxRouteFor } from "@btravstack/htmx-server/internal";
import {
  defineAuth,
  type Authenticators,
  type HttpAuth,
  type SchemeProviders,
  type SchemesFrom,
  type VocabFrom,
} from "@btravstack/http-server/internal";
import type { Kinds, UnitsOf } from "@btravstack/http-server/internal";

import { controllerFor } from "./controller.js";
import { routerFor } from "./orpc.js";

export type { Authenticators, SchemesFrom } from "@btravstack/http-server/internal";

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
  readonly authenticators: HttpAuth<A>["authenticators"];
  /** Bound scheme providers for answerers composed without `HttpModule`. */
  readonly providers: HttpAuth<A>["providers"];
  /** One port per scheme carrying that scheme's principal. */
  readonly principals: HttpAuth<A>["principals"];
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
  const auth = defineAuth(options);
  const routes = htmxRouteFor<SchemesFrom<A>, VocabFrom<A>>();
  const http: Http<A> = {
    OrpcController: controllerFor<SchemesFrom<A>>(),
    OrpcRouter: routerFor<SchemesFrom<A>, SchemeProviders<A>, VocabFrom<A>>(
      auth.providers as never,
      auth.principals,
    ),
    HtmxFragments: htmxFragmentsFor<SchemeProviders<A>>(auth.providers as never, auth.principals),
    HtmxGet: routes.HtmxGet,
    HtmxPost: routes.HtmxPost,
    authenticators: auth.authenticators,
    providers: auth.providers,
    principals: auth.principals,
    units: () => http as never,
  };
  return http;
};
