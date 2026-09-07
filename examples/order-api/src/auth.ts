import { TenantId, TenantIdSchema } from "@btravstack/example-order-domain";
import { apiKeyAuthenticator, defineHttp } from "@btravstack/http-server";
import { jwtAuthenticator, type Claims } from "@btravstack/http-server/jwt";

import type { RequestModule, ServiceModule, UserModule } from "./request-scope.js";

/**
 * What this deployment knows about a caller under the `user` scheme — and the
 * one place it is stated.
 *
 * **The contract says whether a route is protected and under which schemes; this
 * says what each scheme resolves to.** The contract names no identity type at
 * all, so none of this reaches a client and enriching it is never a contract
 * change.
 *
 * `tenantId` is the domain's `TenantId` rather than a `string`, so a handler
 * passes it straight to a use case and the brand travels with it instead of
 * being re-claimed at each call.
 */
export type Identity = { readonly tenantId: TenantId; readonly userId: string };

/** What the `service` scheme resolves to: a machine caller, with no tenant of its own. */
export type ServiceIdentity = { readonly appId: string };

/**
 * What a verified token means here, and the one place this deployment's claim
 * spelling is written: `sub` is the user, `tenant` is the tenant. No standard
 * claim carries a tenant, so the name is the issuer's — `tid` on Entra,
 * `org_id` on Auth0 — and it is named here rather than anywhere downstream.
 *
 * This is also where a claim becomes a **tenant**, so it is the one place this
 * path claims the `TenantId` brand — and the one place it earns the cast, by
 * parsing first: a claim is the issuer's string, not a contract-validated
 * input. Answering `undefined` refuses the token, which is a 401.
 */
const principal = (claims: Claims): Identity | undefined => {
  const tenant = claims["tenant"];
  return typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof tenant === "string" &&
    TenantIdSchema.safeParse(tenant).success
    ? { tenantId: TenantId(tenant), userId: claims.sub }
    : undefined;
};

/**
 * The `user` scheme: a real OIDC token, verified against the issuer's JWKS.
 * Nothing is pinned, so `HTTP_JWT_JWKS_URI`, `HTTP_JWT_ISSUER` and
 * `HTTP_JWT_AUDIENCE` are what a deployment sets — and an unset one is a
 * `ConfigInvalid` naming it at startup, not a 401 in production.
 *
 * The scope vocabulary is declared at the call, so the granted list is the
 * intersection of it with the token's own `scope` claim rather than a string
 * compared at the endpoint.
 */
export const userAuth = jwtAuthenticator<Identity>()({
  principal,
  scopes: ["orders:export"],
});

/**
 * The second scheme: an API key, no scopes, no tenant — what a reporting job
 * presents — the starter's own `apiKeyAuthenticator`, which compares digests
 * rather than strings and checks every issued key without an early return.
 *
 * The key list is inline here because an example has no secret store. A
 * deployment reads it from a config field bound off `Env`, since a key list in
 * the image is a key list in the repository.
 */
export const serviceAuth = apiKeyAuthenticator<ServiceIdentity>()({
  keys: [{ key: "reporting", principal: { appId: "reporting" } }],
});

/**
 * The one door: every HTTP entity this application mints comes from here, and
 * declaring a scheme and implementing it are the same act — so there is no
 * registry to keep in step and no authenticator for a root to list.
 *
 * Held whole rather than destructured: each destructured member expands to a
 * type mentioning `@btravstack/contract`'s inaccessible `unique symbol`, which
 * this file could not emit (TS2527).
 */
export const auth = defineHttp({ authenticators: { user: userAuth, service: serviceAuth } });

/**
 * The same object, retyped with the module each unit kind binds — a second
 * step, and it has to be: `UserModule` names `auth.principals.user` in its own
 * `needs`, so folding the kinds into `defineHttp` would make the two mutually
 * recursive (TS7022). `import type` is what keeps that a type-level cycle only.
 */
export const api = auth.units<{
  anonymous: typeof RequestModule;
  user: typeof UserModule;
  service: typeof ServiceModule;
}>();
