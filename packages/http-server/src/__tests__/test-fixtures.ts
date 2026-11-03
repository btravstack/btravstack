import { IncomingMessage, createServer } from "node:http";
import { Socket, type AddressInfo } from "node:net";

import { Env, type Environment } from "@btravstack/config";
import { Observers, noObserverMember } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { it as base, type HttpFixtures } from "@btravstack/internal-http-fixtures";
import { createFakeClock } from "@btravstack/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Configuration, customFetch, enableNonRepudiationChecks } from "openid-client";
import { ErrAsync, Ok, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { vi, type TestAPI } from "vitest";

import { HttpHandler } from "../handler.js";
import {
  JwtVerifier,
  jwtVerifier,
  type JwtVerifierOptions,
  type JwtVerifierService,
} from "../jwt.js";
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
import { oidc, type OidcOptions } from "../oidc.js";
import { SessionCodec, sessionCodec } from "../session.js";

type TokenFixtures = {
  tokens: Awaited<ReturnType<typeof tokenFixture>>;
  incoming: IncomingMessage;
  verification: Awaited<ReturnType<typeof jwtVerificationFixture>>;
  rotation: Awaited<ReturnType<typeof rotatingVerificationFixture>>;
  misdeclared: Awaited<ReturnType<typeof misdeclaredKeyFixture>>;
};

export const it: TestAPI<HttpFixtures & TokenFixtures> = base.extend<TokenFixtures>({
  verification: async ({ issuer }, use) => {
    await use(await jwtVerificationFixture(issuer));
  },
  rotation: async ({ task: _task }, use) => {
    const fixture = await rotatingVerificationFixture();
    await use(fixture);
    vi.useRealTimers();
    await fixture.close();
  },
  misdeclared: async ({ task: _task }, use) => {
    const fixture = await misdeclaredKeyFixture();
    await use(fixture);
    await fixture.close();
  },
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
  let refreshGate:
    | {
        entered: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
      }
    | undefined;
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
    const gate = refreshGate;
    gate?.entered.resolve();
    if (gate !== undefined) await gate.release.promise;
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
  const manager = (clientId = "staff", issuer = "https://issuer.example") =>
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
      { issuer, clientId },
    );
  const service = manager();
  const login = (subject = "alice", refresh = true, idToken?: string) =>
    service
      .create(
        { principal: { userId: subject }, iss: "https://issuer.example", clientId: "staff" },
        subject,
        {
          access_token: `access-${subject}`,
          token_type: "Bearer",
          expires_in: 60,
          ...(refresh ? { refresh_token: `refresh-${subject}` } : {}),
          ...(idToken === undefined ? {} : { id_token: idToken }),
        },
      )
      .getOrThrow();
  return {
    codec,
    clock,
    pauseRefresh: () => {
      const entered = deferred();
      const release = deferred();
      refreshGate = { entered, release };
      return {
        entered: entered.promise,
        release: () => {
          release.resolve();
        },
      };
    },
    loginProvider: (
      options: Pick<
        OidcOptions<unknown>,
        "postLogoutRedirectUri" | "variablePrefix" | "postLogout"
      > = {},
      withoutTokens = false,
      environment: Record<string, string | undefined> = {},
    ) =>
      Module.scoped(
        Module("LogoutConfigurationFixture")({
          provides: [
            Provider(Env)({ inject: {}, value: environment }),
            noObserverMember,
            Provider(SessionCodec)({ inject: {}, value: codec }),
            Provider(OidcTokens)({ inject: {}, value: service }),
            ...oidc()({
              issuer: "https://issuer.example",
              clientId: "staff",
              clientSecret: "secret",
              redirectUri: "https://app.example/auth/callback",
              ...options,
              ...(withoutTokens ? {} : { tokens: OidcTokens }),
              principal: (claims) => claims,
            }),
          ],
          exports: [HttpHandler],
        }),
        (ctx) => OkAsync(ctx.get(HttpHandler)),
      ),
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

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function jwtVerificationFixture(issuer: HttpFixtures["issuer"]) {
  const observations: unknown[] = [];
  const configured = (options: Omit<JwtVerifierOptions, "port">, environment: Environment = {}) =>
    Module.scoped(
      Module("JwtVerificationFixture")({
        provides: [
          Provider(Env)({ inject: {}, value: environment }),
          Provider.member(Observers)({
            inject: {},
            value: (operation) => (settled) => {
              observations.push({ operation, settled });
            },
          }),
          jwtVerifier(options),
        ],
        exports: [JwtVerifier],
      }),
      (ctx) => OkAsync(ctx.get(JwtVerifier)),
    );
  const service = await configured({ jwks: issuer.jwks, issuer: issuer.issuer }).getOrThrow();
  const custom = await Module.scoped(
    Module("NamedJwtVerificationFixture")({
      provides: [
        Provider(Env)({ inject: {}, value: {} }),
        noObserverMember,
        jwtVerifier({ port: NamedJwtVerifier, jwks: issuer.jwks, issuer: issuer.issuer }),
      ],
      exports: [NamedJwtVerifier],
    }),
    (ctx) => OkAsync(ctx.get(NamedJwtVerifier)),
  ).getOrThrow();
  return { service, custom, configured, observations };
}

class NamedJwtVerifier extends Port("NamedJwtVerifierFixture")<JwtVerifierService> {}

async function rotatingVerificationFixture() {
  const pairs = await Promise.all([generateKeyPair("ES256"), generateKeyPair("ES256")]);
  const keys = await Promise.all(
    pairs.map(async (pair, index) => ({
      ...(await exportJWK(pair.publicKey)),
      kid: `key-${index}`,
      alg: "ES256",
      use: "sig",
    })),
  );
  let current = 0;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [keys[current]] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = "https://rotating.example";
  const service = await Module.scoped(
    Module("RotatingJwtVerificationFixture")({
      provides: [
        Provider(Env)({ inject: {}, value: {} }),
        noObserverMember,
        jwtVerifier({ issuer, jwks: `http://127.0.0.1:${port}/jwks` }),
      ],
      exports: [JwtVerifier],
    }),
    (ctx) => OkAsync(ctx.get(JwtVerifier)),
  ).getOrThrow();
  return {
    service,
    requests: () => requests,
    sign: (audience: string) =>
      new SignJWT({ sub: "caller" })
        .setProtectedHeader({ alg: "ES256", kid: `key-${current}` })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("5m")
        .sign(pairs[current]!.privateKey),
    rotate: () => {
      current = 1;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31_000);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function misdeclaredKeyFixture() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "published", alg: "ES256" };
  let metadata: Readonly<Record<string, unknown>> = {};
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...jwk, ...metadata }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = "https://misdeclared.example";
  const audience = "service-a";
  const service = await Module.scoped(
    Module("MisdeclaredJwtVerificationFixture")({
      provides: [
        Provider(Env)({ inject: {}, value: {} }),
        noObserverMember,
        jwtVerifier({ issuer, jwks: `http://127.0.0.1:${port}/jwks` }),
      ],
      exports: [JwtVerifier],
    }),
    (ctx) => OkAsync(ctx.get(JwtVerifier)),
  ).getOrThrow();
  return {
    service,
    audience,
    publish: (published: Readonly<Record<string, unknown>>) => {
      metadata = published;
    },
    sign: (header: { readonly kid?: string } = { kid: jwk.kid }) =>
      new SignJWT({ sub: "caller" })
        .setProtectedHeader({ alg: "ES256", ...header })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("5m")
        .sign(privateKey),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
