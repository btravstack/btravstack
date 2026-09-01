import { TenantId } from "@btravstack/example-order-domain";
import {
  HttpAuthenticator,
  Unauthenticated,
  apiKeyAuthenticator,
  defineHttp,
  granted,
} from "@btravstack/http-server";
import { ErrAsync, OkAsync } from "unthrown";

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
 * A stand-in, not a recommendation: `Bearer <tenantId>:<userId>:<scopes>`. It is
 * where a header becomes a **tenant**, and so the one place this path claims the
 * `TenantId` brand — from here on the identity carries it.
 *
 * The scope vocabulary is declared at the call, so the granted list is checked
 * against it here rather than compared as strings at the endpoint.
 */
export const userAuth = HttpAuthenticator<Identity, "orders:export">()({
  inject: {},
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const [tenantId, userId, ...rest] = token.split(":");
    // Rejoined rather than taken as one field: a scope name contains the
    // delimiter itself, so `orders:export` cannot survive a plain third field.
    const claimed = rest.join(":");
    return tenantId === undefined || tenantId === "" || userId === undefined || userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync(
          granted(
            { tenantId: TenantId(tenantId), userId },
            claimed
              .split(",")
              .filter((scope): scope is "orders:export" => scope === "orders:export"),
          ),
        );
  },
});

/**
 * The second scheme: an API key, no scopes, no tenant — what a reporting job
 * presents. Unlike `userAuth` above, this one is NOT a stand-in: it is the
 * starter's own `apiKeyAuthenticator`, which compares digests rather than
 * strings and checks every issued key without an early return.
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
export const api = defineHttp({ authenticators: { user: userAuth, service: serviceAuth } });
