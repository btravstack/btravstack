// The type half of the session codec: the cookie carries the APPLICATION's own
// principal, the provider binds its keys from the environment, and `seal` is
// handed a session without a lifetime — which is what stops a caller minting one
// that outlives the policy. Each `@ts-expect-error` is an assertion.
import type { ConfigInvalid, Env } from "@btravstack/config";
import type { Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import type { Authenticator } from "./auth.js";
import { defineHttp } from "./define-http.js";
import { html } from "./html.js";
import { HttpModule } from "./http-module.js";
import {
  SessionCodec,
  sessionAuthenticator,
  sessionCodec,
  type Session,
  type SessionCodecService,
} from "./session.js";

type Identity = { readonly tenantId: string; readonly userId: string };

expectTypeOf<Session<Identity>["principal"]>().toEqualTypeOf<Identity>();

// Nothing pinned: the keys arrive from `HTTP_SESSION_KEYS`, so the provider
// needs `Env` and reports `ConfigInvalid`.
expectTypeOf(sessionCodec()).toEqualTypeOf<
  Provider<SessionCodec, ConfigInvalid, Env> & { readonly port: typeof SessionCodec }
>();

expectTypeOf(sessionCodec({ keys: ["k"], ttlSec: 60 })).toEqualTypeOf<
  Provider<SessionCodec, ConfigInvalid, Env> & { readonly port: typeof SessionCodec }
>();

declare const codec: SessionCodecService;

// Positive: a principal, with and without the provider's session id.
void codec.seal({ principal: { userId: "u-1" } });
void codec.seal({ principal: { userId: "u-1" }, sid: "s-1" });

void codec.seal({
  principal: { userId: "u-1" },
  // @ts-expect-error -- Object literal may only specify known properties, and 'exp' does not exist
  exp: 1,
});

// The scheme: its needs channel is the CODEC's port, so a root composing it
// without `sessionCodec()` is di's own unmet need — and its vocabulary is
// inferred from `scopes`, exactly as `jwtAuthenticator`'s is.
const browserAuth = sessionAuthenticator<Identity>()();

expectTypeOf(browserAuth).toEqualTypeOf<Authenticator<Identity, never, SessionCodec, never>>();

const scopedAuth = sessionAuthenticator<Identity>()({
  cookie: "session",
  scopes: ["orders:export"],
  principal: (session) => session.principal as Identity,
});

expectTypeOf(scopedAuth).toEqualTypeOf<
  Authenticator<Identity, "orders:export", SessionCodec, never>
>();

const api = defineHttp({ authenticators: { session: scopedAuth } });

const exports = api.HtmxGet("/exports", { requires: [{ session: ["orders:export"] }] })({
  inject: {},
  sync: () => (context) => OkAsync(html`${context.principal.userId}`),
});

// Positive: the codec composed beside the scheme discharges it.
void HttpModule("SessionRoot")({
  fragments: api.HtmxFragments([exports]),
  provides: [exports, sessionCodec()],
});

// @ts-expect-error -- UNDECLARED NEEDS: nothing discharges `SessionCodec`
void HttpModule("SessionRootWithoutCodec")({
  fragments: api.HtmxFragments([exports]),
  provides: [exports],
});

// Negative: a scope outside the vocabulary, refused at the route's own mint.
api.HtmxGet("/admin", {
  // @ts-expect-error -- UNGRANTABLE SCOPE: "orders:admin" is not one `session` can grant
  requires: [{ session: ["orders:admin"] }],
})({ inject: {}, sync: () => () => OkAsync(html`admin`) });
