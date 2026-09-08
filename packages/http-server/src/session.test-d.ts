// The type half of the session codec: the cookie carries the APPLICATION's own
// principal, the provider binds its keys from the environment, and `seal` is
// handed a session without a lifetime — which is what stops a caller minting one
// that outlives the policy. Each `@ts-expect-error` is an assertion.
import type { ConfigInvalid, Env } from "@btravstack/config";
import type { Provider } from "@btravstack/di";
import { expectTypeOf } from "vitest";

import { SessionCodec, sessionCodec, type Session, type SessionCodecService } from "./session.js";

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
