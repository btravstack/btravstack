import { HttpAuthenticator } from "./auth.js";
import { controllerFor } from "./controller.js";
import { routerFor } from "./orpc.js";

/**
 * Mints `HttpController`, `HttpRouter` and `HttpAuthenticator` fixed to **this
 * deployment's** identity — the server-side mirror of `auth<P>()` on the
 * contract side:
 *
 * ```ts
 * type Identity = { readonly tenantId: string; readonly userId: string };
 * export const { HttpController, HttpRouter, HttpAuthenticator } = httpAuth<Identity>();
 * ```
 *
 * A contract declares the **client-visible minimum** — `{ tenantId }` — and
 * says *whether* a route is protected. What the server actually resolved is
 * usually more, and a handler could not see the extra fields: their type was
 * read off the contract. `Identity` is where that is stated instead, once, and
 * every slice's controller infers from it with no annotation of its own. The
 * authenticator and the controllers cannot disagree, because both come from
 * this call.
 *
 * `HttpModule`'s gate is unchanged and still checks the authenticator's
 * principal satisfies the contract's — a subtype discharges it, which is
 * exactly what an `Identity` richer than the contract's `Principal` is.
 *
 * Written once per application, and per application rather than per slice
 * because a handler's parameter types are fixed where the arrow is written: a
 * composition root cannot re-type a `sync` callback that lives in another
 * module, so the identity has to be in scope where the handler is.
 *
 * The `HttpAuthenticator` handed back is already applied — the type argument
 * `HttpAuthenticator<P>()` exists to state is what this factory just fixed —
 * so it is called `HttpAuthenticator([deps], { sync })`.
 */
export const httpAuth = <Identity>(): {
  readonly HttpController: ReturnType<typeof controllerFor<Identity>>;
  readonly HttpRouter: ReturnType<typeof routerFor<Identity>>;
  readonly HttpAuthenticator: ReturnType<typeof HttpAuthenticator<Identity>>;
} => ({
  HttpController: controllerFor<Identity>(),
  HttpRouter: routerFor<Identity>(),
  HttpAuthenticator: HttpAuthenticator<Identity>(),
});
