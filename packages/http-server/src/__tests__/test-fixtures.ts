import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { Env } from "@btravstack/config";
import { noObserverMember } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { it as base, type HttpFixtures } from "@btravstack/internal-http-fixtures";
import { createFakeClock } from "@btravstack/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Configuration, customFetch, enableNonRepudiationChecks } from "openid-client";
import { ErrAsync, Ok, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import type { TestAPI } from "vitest";

import { HttpHandler } from "../handler.js";
import type {
  OidcTokenStoreService,
  OidcTokenUpdate,
  StoredOidcTokens,
} from "../oidc-token-store.js";
import {
  createOidcTokens,
  oidcTokens,
  OidcTokens,
  OidcTokenStore,
  OidcTokenStoreUnavailable,
  type OidcTokensOptions,
} from "../oidc-tokens.js";
import { oidc } from "../oidc.js";
import { SessionCodec, sessionCodec } from "../session.js";

type TokenFixtures = {
  tokens: Awaited<ReturnType<typeof tokenFixture>>;
  incoming: IncomingMessage;
};

export const it: TestAPI<HttpFixtures & TokenFixtures> = base.extend<TokenFixtures>({
  incoming: async ({ task: _task }, use) => {
    const socket = new Socket();
    await use(new IncomingMessage(socket));
    socket.destroy();
  },
  tokens: async ({ task: _task }, use) => {
    await use(await tokenFixture());
  },
});

async function tokenFixture() {
  const codec = await Module.scoped(
    Module("TokenCodecFixture")({
      provides: [
        Provider(Env)({ inject: {}, value: {} }),
        sessionCodec({ keys: [Buffer.alloc(32, 1).toString("base64url")] }),
      ],
      exports: [SessionCodec],
    }),
    (ctx) => OkAsync(ctx.get(SessionCodec)),
  ).getOrThrow();
  const clock = createFakeClock(Date.now());
  const rows = new Map<string, StoredOidcTokens>();
  const locks = new Map<string, Promise<void>>();
  const calls: string[] = [];
  const observations: unknown[] = [];
  let response: object = {
    access_token: "refreshed-access",
    token_type: "Bearer",
    expires_in: 120,
    refresh_token: "rotated-refresh",
  };
  let status = 200;
  let unavailable = false;
  const signer = await generateKeyPair("ES256");
  const jwk = await exportJWK(signer.publicKey);
  const configuration = new Configuration(
    {
      issuer: "https://issuer.example",
      token_endpoint: "https://issuer.example/token",
      jwks_uri: "https://issuer.example/jwks",
      id_token_signing_alg_values_supported: ["ES256"],
    },
    "staff",
    { client_secret: "secret", id_token_signed_response_alg: "ES256" },
  );
  enableNonRepudiationChecks(configuration);
  configuration[customFetch] = async (url, init) => {
    if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
    calls.push(String(init?.body));
    return Response.json(response, { status });
  };
  const store: OidcTokenStoreService = {
    create: (reference, record) => {
      if (unavailable) return ErrAsync(new OidcTokenStoreUnavailable());
      rows.set(reference, record);
      return OkAsync();
    },
    transact: <T>(
      reference: string,
      work: (record: StoredOidcTokens | undefined) => AsyncResult<OidcTokenUpdate<T>, never>,
    ) => {
      if (unavailable) return ErrAsync(new OidcTokenStoreUnavailable());
      const waiting = locks.get(reference) ?? Promise.resolve();
      const result = fromSafePromise(waiting)
        .flatMap(() => work(rows.get(reference)))
        .tap(({ record }) => {
          if (record === undefined) rows.delete(reference);
          else rows.set(reference, record);
        })
        .flatMap(({ value }) => Ok(value));
      locks.set(
        reference,
        result
          .map(() => undefined)
          .recoverDefect(() => OkAsync(undefined))
          .get(),
      );
      return result;
    },
  };
  const manager = (clientId = "staff") =>
    createOidcTokens(
      configuration,
      codec,
      store,
      [
        (operation) => (settled) => {
          observations.push({ operation, settled });
        },
      ],
      clock,
      { issuer: "https://issuer.example", clientId },
    );
  const service = manager();
  const login = (subject = "alice", refresh = true) =>
    service
      .create(
        { principal: { userId: subject }, iss: "https://issuer.example", clientId: "staff" },
        subject,
        {
          access_token: `access-${subject}`,
          token_type: "Bearer",
          expires_in: 60,
          ...(refresh ? { refresh_token: `refresh-${subject}` } : {}),
        },
      )
      .getOrThrow();
  return {
    codec,
    clock,
    idToken: async (subject: string, trusted = true) => {
      const key = trusted ? signer.privateKey : (await generateKeyPair("ES256")).privateKey;
      return await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("https://issuer.example")
        .setAudience("staff")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key);
    },
    failStore: () => {
      unavailable = true;
    },
    provider: (options: OidcTokensOptions) =>
      Module.scoped(
        Module("TokensProviderFixture")({
          provides: [
            Provider(Env)({ inject: {}, value: {} }),
            noObserverMember,
            Provider(SessionCodec)({ inject: {}, value: codec }),
            Provider(OidcTokenStore)({ inject: {}, value: store }),
            oidcTokens(options),
          ],
          exports: [OidcTokens],
        }),
        (ctx) => OkAsync(ctx.get(OidcTokens)),
      ),
    mismatchedLogin: () =>
      Module.scoped(
        Module("MismatchedLoginFixture")({
          provides: [
            Provider(Env)({ inject: {}, value: {} }),
            noObserverMember,
            Provider(SessionCodec)({ inject: {}, value: codec }),
            Provider(OidcTokens)({ inject: {}, value: manager("other-client") }),
            ...oidc()({
              issuer: "https://issuer.example",
              clientId: "staff",
              clientSecret: "secret",
              redirectUri: "https://app.example/auth/callback",
              tokens: OidcTokens,
              principal: (claims) => claims,
            }),
          ],
          exports: [HttpHandler],
        }),
        (ctx) => OkAsync(ctx.get(HttpHandler)),
      ),
    rows,
    store,
    service,
    manager,
    calls,
    observations,
    login,
    respond: (body: object, code = 200) => {
      response = body;
      status = code;
    },
  };
}
