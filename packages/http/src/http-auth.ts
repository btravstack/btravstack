import { HttpAuthenticator } from "./auth.js";
import { controllerFor } from "./controller.js";
import { routerFor } from "./orpc.js";

/**
 * Mints `HttpController`, `HttpRouter` and `HttpAuthenticator` fixed to **this
 * deployment's** identity:
 *
 * ```ts
 * type Identity = { readonly tenantId: string; readonly userId: string };
 * export const { HttpController, HttpRouter, HttpAuthenticator } = httpAuth<Identity>();
 * ```
 *
 * **The contract says whether a route is protected; this says what the
 * principal is.** The contract names no identity type at all, so nothing about
 * the server's own view of a caller reaches a client, and `Identity` is stated
 * here once — every slice's controller infers from it with no annotation of
 * its own, and the authenticator and the controllers cannot disagree, because
 * both come from this call.
 *
 * That is also what `HttpModule`'s gate now compares: the **router's** identity
 * against the **authenticator's**, so a router from `httpAuth<A>()` refuses an
 * authenticator from `httpAuth<B>()`. The authenticator must resolve at least
 * what the handlers read, so a subtype discharges it.
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
export const httpAuth = <Identity>(): HttpAuth<Identity> => ({
  HttpController: controllerFor<Identity>(),
  HttpRouter: routerFor<Identity>(),
  HttpAuthenticator: HttpAuthenticator<Identity>(),
});

/**
 * The three, as one type. `Identity` reaches a `.d.ts` through these aliases
 * rather than through the inferred type of the call: what a controller's port
 * expands to carries `@btravstack/contract`'s phantom `unique symbol`, which no
 * consumer can name (TS2527, measured on `examples/order-api`). A file that
 * exports what `httpAuth` returns annotates with them.
 */
export type HttpAuth<Identity> = {
  readonly HttpController: HttpControllerOf<Identity>;
  readonly HttpRouter: HttpRouterOf<Identity>;
  readonly HttpAuthenticator: HttpAuthenticatorOf<Identity>;
};

export type HttpControllerOf<Identity> = ReturnType<typeof controllerFor<Identity>>;
export type HttpRouterOf<Identity> = ReturnType<typeof routerFor<Identity>>;
export type HttpAuthenticatorOf<Identity> = ReturnType<typeof HttpAuthenticator<Identity>>;
