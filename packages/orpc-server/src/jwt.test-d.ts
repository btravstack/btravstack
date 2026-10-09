// The type half of the JWT scheme: its three transport options are OPTIONAL —
// pins, over variables the deployment sets — and the description it hands back
// carries `Env | Observers` in its needs channel and `ConfigInvalid` in its
// error one, so a misconfigured deployment fails the boot with a typed error
// rather than refusing every caller. `Observers` is there because an ISSUER
// outage is reported rather than swallowed, and it costs a root nothing:
// `httpServer` contributes the no-op member and exports the port. Each
// `@ts-expect-error` is an assertion.
import type { ConfigInvalid, EnvReading } from "@btravstack/config";
import type { Observers } from "@btravstack/core";
import { html } from "@btravstack/htmx-server";
import type { Authenticator } from "@btravstack/http-server";
import { jwtAuthenticator, type Claims, type JwtOptions } from "@btravstack/http-server/jwt";
import { defineHttp } from "@btravstack/orpc-server";
import { HttpModule } from "@btravstack/orpc-server";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

type Identity = { readonly tenantId: string; readonly userId: string };

const principal = (claims: Claims): Identity | undefined =>
  typeof claims["tenant"] === "string" && typeof claims.sub === "string"
    ? { tenantId: claims["tenant"], userId: claims.sub }
    : undefined;

// Nothing pinned: every option arrives from `HTTP_JWT_*`, and the needs name
// the three variables as REQUIRED, so a boot's `env` must carry them.
const fromEnvironment = jwtAuthenticator<Identity>()({ principal });

expectTypeOf(fromEnvironment).toEqualTypeOf<
  Authenticator<
    Identity,
    never,
    EnvReading<"HTTP_JWT_JWKS_URI" | "HTTP_JWT_ISSUER" | "HTTP_JWT_AUDIENCE", never> | Observers,
    ConfigInvalid
  >
>();

// A second scheme's variables carry its own prefix, in the type as at run time.
const customer = jwtAuthenticator<Identity>()({ variablePrefix: "HTTP_JWT_CUSTOMER", principal });

expectTypeOf(customer).toEqualTypeOf<
  Authenticator<
    Identity,
    never,
    | EnvReading<
        "HTTP_JWT_CUSTOMER_JWKS_URI" | "HTTP_JWT_CUSTOMER_ISSUER" | "HTTP_JWT_CUSTOMER_AUDIENCE",
        never
      >
    | Observers,
    ConfigInvalid
  >
>();

// All three pinned — what a test does — reads none of them.
const pinned = jwtAuthenticator<Identity>()({
  jwks: "http://127.0.0.1:1/jwks.json",
  issuer: "https://issuer.test",
  audience: "orders-api",
  scopes: ["orders:export"],
  principal,
});

expectTypeOf(pinned).toEqualTypeOf<
  Authenticator<Identity, "orders:export", EnvReading<never, never> | Observers, ConfigInvalid>
>();

// A pin that may be absent leaves its variable optional: only the call knows.
declare const maybeIssuer: string | undefined;
const maybePinned = jwtAuthenticator<Identity>()({
  jwks: "http://127.0.0.1:1/jwks.json",
  issuer: maybeIssuer,
  principal,
});

expectTypeOf(maybePinned).toEqualTypeOf<
  Authenticator<
    Identity,
    never,
    EnvReading<"HTTP_JWT_AUDIENCE", "HTTP_JWT_ISSUER"> | Observers,
    ConfigInvalid
  >
>();

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

// A root composing a scheme that configures itself from the environment writes
// no `needs` line: `HttpModule` carries `Env` for its schemes, the same way it
// already carries the starter's own. The negative — a scheme needing some other
// unmet port, still refused — is `auth.test-d.ts`'s case 12.
const api = defineHttp({ authenticators: { user: fromEnvironment } });

const profile = api.HtmxGet("/profile", { requires: [{ user: [] }] })({
  inject: {},
  sync: () => (context) => OkAsync(html`${context.principal.userId}`),
});

void HttpModule("EnvJwtRoot")({
  fragments: api.HtmxFragments([profile]),
  provides: [profile],
});

// The exported options type takes any prefix when its own parameter is left
// out: a reusable options object annotated with it still compiles.
const reusable: JwtOptions<Identity, readonly []> = {
  variablePrefix: "HTTP_JWT_PARTNER",
  principal,
};
void reusable;
