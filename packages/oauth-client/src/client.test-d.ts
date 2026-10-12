/**
 * The variables `oauthClient()` reads are in its type: unpinned, all three are
 * required at the boot site; pinned, none is read. A misspelt option is refused
 * at its own key rather than silently ignored.
 *
 * Type-checked by this package's `typecheck` script, never executed.
 */
import type { ConfigInvalid, EnvReading } from "@btravstack/config";
import type { HealthChecks } from "@btravstack/core";
import type { Module } from "@btravstack/di";
import { expectTypeOf } from "vitest";

import { oauthClient } from "./client.js";
import type { TokenRequest, TokenSource } from "./token-source.js";

expectTypeOf(oauthClient()).toEqualTypeOf<
  Module<
    TokenSource | HealthChecks,
    ConfigInvalid,
    EnvReading<"OAUTH_ISSUER" | "OAUTH_CLIENT_ID" | "OAUTH_CLIENT_SECRET", never>
  >
>();

expectTypeOf(
  oauthClient({
    issuer: "https://issuer.example/",
    clientId: "gateway",
    clientSecret: "from-a-secret-store",
  }),
).toEqualTypeOf<Module<TokenSource | HealthChecks, ConfigInvalid, EnvReading<never, never>>>();

declare const maybe: string | undefined;
expectTypeOf(oauthClient({ issuer: maybe })).toEqualTypeOf<
  Module<
    TokenSource | HealthChecks,
    ConfigInvalid,
    EnvReading<"OAUTH_CLIENT_ID" | "OAUTH_CLIENT_SECRET", "OAUTH_ISSUER">
  >
>();

// @ts-expect-error — `issuerUrl` is not an option; the issuer is `issuer`.
oauthClient({ issuerUrl: "https://issuer.example/" });

const delegated: TokenRequest = {
  audience: "orders",
  onBehalfOf: {
    token: "subject-token",
    tokenType: "urn:ietf:params:oauth:token-type:access_token",
    actor: { token: "actor-token", tokenType: "urn:ietf:params:oauth:token-type:access_token" },
  },
};
expectTypeOf(delegated).toEqualTypeOf<TokenRequest>();

// @ts-expect-error — a subject token always states its RFC 8693 token type.
const untypedSubject: TokenRequest = { audience: "orders", onBehalfOf: { token: "subject" } };

const untypedActor: TokenRequest = {
  audience: "orders",
  onBehalfOf: {
    token: "subject",
    tokenType: "urn:ietf:params:oauth:token-type:access_token",
    // @ts-expect-error — an actor token always states its RFC 8693 token type.
    actor: { token: "actor" },
  },
};

void untypedSubject;
void untypedActor;
