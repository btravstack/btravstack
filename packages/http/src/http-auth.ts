import { HttpAuthenticator } from "./auth.js";
import { controllerFor } from "./controller.js";
import { routerFor } from "./orpc.js";

/**
 * Mints `HttpController`, `HttpRouter` and `HttpAuthenticator` on one identity —
 * the contract says whether a route is protected, this says what the principal
 * is. Written once per application, because a handler's parameter types are
 * fixed where the arrow is written: a composition root cannot re-type a `sync`
 * callback living in a slice's module. See `packages/http/CLAUDE.md`.
 */
export const httpAuth = <Identity>(): HttpAuth<Identity> => ({
  HttpController: controllerFor<Identity>(),
  HttpRouter: routerFor<Identity>(),
  HttpAuthenticator: HttpAuthenticator<Identity>(),
});

type HttpAuth<Identity> = {
  readonly HttpController: HttpControllerOf<Identity>;
  readonly HttpRouter: HttpRouterOf<Identity>;
  readonly HttpAuthenticator: HttpAuthenticatorOf<Identity>;
};

/**
 * What a consumer annotates with. `Identity` cannot reach a `.d.ts` through the
 * inferred type of the call: a controller's port expands to a type carrying
 * `@btravstack/contract`'s phantom `unique symbol`, which no consumer can name
 * (TS2527, measured on `examples/order-api`).
 */
export type HttpControllerOf<Identity> = ReturnType<typeof controllerFor<Identity>>;
export type HttpRouterOf<Identity> = ReturnType<typeof routerFor<Identity>>;
export type HttpAuthenticatorOf<Identity> = ReturnType<typeof HttpAuthenticator<Identity>>;
