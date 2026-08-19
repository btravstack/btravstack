import {
  httpAuth,
  type HttpAuthenticatorOf,
  type HttpControllerOf,
  type HttpRouterOf,
} from "@btravstack/http";

/**
 * What this deployment knows about a caller, which is **more** than the
 * contract asks for: `Principal` declares `{ tenantId }` alone, because that is
 * all the API's own semantics depend on. `userId` is the server's business and
 * never reaches a client.
 *
 * This is the layering the contract's own doc names, and this file is the one
 * place it is stated. The contract says **whether** a route is protected and
 * what a client must know; `httpAuth<Identity>()` says **what** the principal
 * is, server-side — so a handler sees `Identity`, `userId` included, with no
 * annotation at its own call site. `HttpModule`'s gate is unchanged and still
 * checks the authenticator against the contract's `Principal`; a subtype
 * discharges it, which is what `Identity` is.
 */
export type Identity = { readonly tenantId: string; readonly userId: string };

/**
 * The three the factory mints, together — imported by the slices instead of
 * `@btravstack/http`'s own. Written once per application, because a handler's
 * parameter types are fixed where the arrow is written: the composition root
 * cannot re-type a `sync` callback that lives in a slice's module.
 *
 * The authenticator and the controllers cannot disagree about the identity,
 * since both come from this call.
 *
 * Each is annotated rather than left to inference: a controller's port expands
 * to a type carrying `@btravstack/contract`'s phantom `unique symbol`, which
 * this file cannot name in its own declaration emit (TS2527). The aliases the
 * starter exports are what it names instead.
 */
const identity = httpAuth<Identity>();

export const HttpController: HttpControllerOf<Identity> = identity.HttpController;
export const HttpRouter: HttpRouterOf<Identity> = identity.HttpRouter;
export const HttpAuthenticator: HttpAuthenticatorOf<Identity> = identity.HttpAuthenticator;
