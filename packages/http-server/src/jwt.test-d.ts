// The type half of the JWT scheme: its three transport options are OPTIONAL —
// pins, over variables the deployment sets — and the description it hands back
// carries `Env` in its needs channel and `ConfigInvalid` in its error one, so a
// misconfigured deployment fails the boot with a typed error rather than
// refusing every caller. Each `@ts-expect-error` is an assertion.
import type { ConfigInvalid, Env } from "@btravstack/config";
import { expectTypeOf } from "vitest";

import type { Authenticator } from "./auth.js";
import { jwtAuthenticator, type Claims } from "./jwt.js";

type Identity = { readonly tenantId: string; readonly userId: string };

const principal = (claims: Claims): Identity | undefined =>
  typeof claims["tenant"] === "string" && typeof claims.sub === "string"
    ? { tenantId: claims["tenant"], userId: claims.sub }
    : undefined;

// Nothing pinned: every option arrives from `HTTP_JWT_*`.
const fromEnvironment = jwtAuthenticator<Identity>()({ principal });

expectTypeOf(fromEnvironment).toEqualTypeOf<Authenticator<Identity, never, Env, ConfigInvalid>>();

// All three pinned — what a test does — is the same description.
const pinned = jwtAuthenticator<Identity>()({
  jwks: "http://127.0.0.1:1/jwks.json",
  issuer: "https://issuer.test",
  audience: "orders-api",
  scopes: ["orders:export"],
  principal,
});

expectTypeOf(pinned).toEqualTypeOf<Authenticator<Identity, "orders:export", Env, ConfigInvalid>>();

// Negative: a second accepted issuer is a second authenticator, not an array —
// an environment carries one string, so the array forms are gone.
jwtAuthenticator<Identity>()({
  // @ts-expect-error -- Type 'string[]' is not assignable to type 'string'
  issuer: ["https://issuer.test", "https://other.test"],
  principal,
});

jwtAuthenticator<Identity>()({
  // @ts-expect-error -- Type 'string[]' is not assignable to type 'string'
  audience: ["orders-api", "billing-api"],
  principal,
});
