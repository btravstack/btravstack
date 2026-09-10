// The type half of the login answerer: it is one member of the HTTP set port,
// its needs are the environment and the CODEC's port — so a root that composes
// it without `sessionCodec()` is di's own unmet need — and `principal` is the
// one option it cannot be built without. Each `@ts-expect-error` is an assertion.
import type { ConfigInvalid, Env } from "@btravstack/config";
import type { Provider } from "@btravstack/di";
import type { IDToken } from "openid-client";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { defineHttp } from "./define-http.js";
import { HttpHandler } from "./handler.js";
import { html } from "./html.js";
import { HttpModule } from "./http-module.js";
import { oidc, type OidcUnreachable } from "./oidc.js";
import { SessionCodec, sessionAuthenticator, sessionCodec } from "./session.js";

type Identity = { readonly tenantId: string; readonly userId: string };

const identityOf = (claims: IDToken): Identity | undefined =>
  typeof claims["tenant"] === "string" && typeof claims.sub === "string"
    ? { tenantId: claims["tenant"], userId: claims.sub }
    : undefined;

// Nothing pinned: the four values arrive from `HTTP_OIDC_*`, so the provider
// needs `Env` beside `SessionCodec` and reports both ways a boot can refuse.
expectTypeOf(oidc({ principal: identityOf })).toEqualTypeOf<
  Provider<HttpHandler, ConfigInvalid | OidcUnreachable, Env | SessionCodec> & {
    readonly port: typeof HttpHandler;
  }
>();

// Every transport option pinned at the call is the same provider: a pin
// replaces a variable, it does not change what the answerer is.
expectTypeOf(
  oidc({
    issuer: "https://issuer.example/",
    clientId: "bff",
    clientSecret: "s3cret",
    redirectUri: "https://app.example/auth/callback",
    prefix: "/session",
    scope: "openid profile",
    postLogout: "/goodbye",
    principal: identityOf,
  }),
).toEqualTypeOf<
  Provider<HttpHandler, ConfigInvalid | OidcUnreachable, Env | SessionCodec> & {
    readonly port: typeof HttpHandler;
  }
>();

// @ts-expect-error -- Property 'principal' is missing: there is no default for what claims mean
void oidc({});

const api = defineHttp({
  authenticators: {
    session: sessionAuthenticator<Identity>()({ scopes: ["orders:export"] }),
  },
});

const row = api.HtmxGet("/orders/:id/row", { requires: [{ session: ["orders:export"] }] })({
  inject: {},
  sync: () => (context) => OkAsync(html`${context.principal.tenantId}`),
});

// Positive: the codec composed beside the answerer discharges what it needs.
void HttpModule("BrowserApi")({
  fragments: api.HtmxFragments([row]),
  fragmentsLogin: "/auth/login",
  provides: [row, sessionCodec(), oidc({ principal: identityOf })],
});

// @ts-expect-error -- UNSATISFIED DEPENDENCIES: nothing discharges `SessionCodec`
void HttpModule("BrowserApiWithoutCodec")({
  fragments: api.HtmxFragments([row]),
  fragmentsLogin: "/auth/login",
  provides: [row, oidc({ principal: identityOf })],
});
