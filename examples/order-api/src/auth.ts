import type { TenantId } from "@btravstack/example-order-domain";
import {
  httpAuth,
  type HttpAuthenticatorOf,
  type HttpControllerOf,
  type HttpRouterOf,
} from "@btravstack/http";

/**
 * What this deployment knows about a caller — and the one place it is stated.
 *
 * **The contract says whether a route is protected; this says what the
 * principal is.** `@btravstack/example-order-api-contract` names no identity
 * type at all, so none of this reaches a client and enriching it — roles, an
 * org tier, an internal id — is never a contract change. A handler minted
 * below sees `Identity` with no annotation at its own call site, and
 * `HttpModule`'s gate compares the router's identity against the
 * authenticator's, both of which come from the one call here.
 *
 * `tenantId` is the domain's `TenantId` rather than a `string`, so the value
 * the authenticator resolved is already the one every port in the application
 * asks for: a handler passes `context.principal.tenantId` straight to a use
 * case, and the brand travels with it instead of being re-claimed at each
 * call.
 */
export type Identity = { readonly tenantId: TenantId; readonly userId: string };

/**
 * The three the factory mints, together — imported by the slices instead of
 * `@btravstack/http`'s own. Written once per application, because a handler's
 * parameter types are fixed where the arrow is written: the composition root
 * cannot re-type a `sync` callback that lives in a slice's module.
 *
 * The authenticator and the controllers cannot disagree about the identity,
 * since both come from this call — and there is no other way to read a
 * principal: a marked fragment reached through `@btravstack/http`'s own
 * top-level `HttpController` types `principal: never`.
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
