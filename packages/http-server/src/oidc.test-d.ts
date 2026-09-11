// The type half of the login answerer: it is one member of the HTTP set port,
// its needs are the environment and the CODEC's port — so a root that composes
// it without `sessionCodec()` is di's own unmet need — and `principal` is the
// one option it cannot be built without. Each `@ts-expect-error` is an assertion.
import { Env, type ConfigInvalid } from "@btravstack/config";
import type { Observers } from "@btravstack/core";
import { Module, type Provider } from "@btravstack/di";
import { oc } from "@orpc/contract";
import type { IDToken } from "openid-client";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { defineHttp } from "./define-http.js";
import { HttpHandler } from "./handler.js";
import { html } from "./html.js";
import { HttpModule } from "./http-module.js";
import { HttpRuntime, http } from "./http-runtime.js";
import { oidc, type OidcUnreachable } from "./oidc.js";
import { SessionCodec, sessionAuthenticator, sessionCodec } from "./session.js";

type Identity = { readonly tenantId: string; readonly userId: string };

const identityOf = (claims: IDToken): Identity | undefined =>
  typeof claims["tenant"] === "string" && typeof claims.sub === "string"
    ? { tenantId: claims["tenant"], userId: claims.sub }
    : undefined;

// Nothing pinned: the four values arrive from `HTTP_OIDC_*`, so the provider
// needs `Env` beside `SessionCodec` — and `Observers`, the set port every
// per-operation starter here reports to, which costs a root nothing because
// `httpServer` already contributes the no-op member and exports the port.
// Both ways a boot can refuse are on the error channel.
expectTypeOf(oidc({ principal: identityOf })).toEqualTypeOf<
  Provider<HttpHandler, ConfigInvalid | OidcUnreachable, Env | SessionCodec | Observers> & {
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
  Provider<HttpHandler, ConfigInvalid | OidcUnreachable, Env | SessionCodec | Observers> & {
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
// Nothing is written here for `Observers` — the starter this sugar imports
// exports it, which is what keeps the set port free to a root.
void HttpModule("BrowserApi")({
  fragments: api.HtmxFragments([row]),
  fragmentsLogin: "/auth/login",
  provides: [row, sessionCodec(), oidc({ principal: identityOf })],
});

// The negative below is built over fragments with NO session scheme, and that
// is the whole point of the second api: `api`'s own `sessionAuthenticator`
// needs `SessionCodec` through `row`, so a root missing the codec refuses
// identically with `oidc()` deleted — a gate that would pass for the wrong
// reason. Here `oidc()` is the only thing that needs it.
const publicApi = defineHttp();

const status = publicApi.HtmxGet("/status")({
  inject: {},
  sync: () => () => OkAsync(html`ok`),
});

// Positive, isolated: nothing but `oidc()` asks for `SessionCodec`, and the
// codec beside it discharges that.
void HttpModule("PublicWithLogin")({
  fragments: publicApi.HtmxFragments([status]),
  provides: [status, sessionCodec(), oidc({ principal: identityOf })],
});

// @ts-expect-error -- UNSATISFIED DEPENDENCIES: nothing discharges `SessionCodec`, which only `oidc()` needs here
void HttpModule("PublicWithLoginNoCodec")({
  fragments: publicApi.HtmxFragments([status]),
  provides: [status, oidc({ principal: identityOf })],
});

// `http()` exports `Observers` too, so a root that imports the oRPC sugar and
// provides `oidc()` beside it discharges the answerer's own need without
// writing an observability line. `httpServer()` exported it and `http()` did
// not, which made that root fail the gate on a port it never named.
const pingContract = oc.router({ ping: oc });

const pingRouter = publicApi.OrpcRouter(pingContract)({
  inject: {},
  sync: () => ({ ping: () => OkAsync("pong") }),
});

void Module("RpcWithLogin")({
  imports: [http()],
  provides: [pingRouter, sessionCodec(), oidc({ principal: identityOf })],
  exports: [HttpRuntime, HttpHandler],
  needs: [Env],
});

// The insecure-issuer opt-in is a boolean option and nothing else.
void oidc({ principal: identityOf, allowInsecureIssuer: true });

void oidc({
  principal: identityOf,
  // @ts-expect-error -- Type 'string' is not assignable to type 'boolean | undefined'
  allowInsecureIssuer: "yes",
});
