import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";

import { Module, Port, Provider } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Err, Ok, OkAsync } from "unthrown";
import { test, vi } from "vitest";
import { z } from "zod";

import { HttpHandler } from "../handler.js";
import { httpServer, HttpRuntime } from "../http-runtime.js";
import type { OidcTokenStoreService, StoredOidcTokens } from "../oidc-token-store.js";
import { oidcTokens, OidcTokens, OidcTokenStore } from "../oidc-tokens.js";
import { oidc, OidcLoginRefused } from "../oidc.js";
import { SessionCodec, sessionCodec, type SessionCodecService } from "../session.js";

export const it = test.extend<{
  boot: Boot;
  provider: Awaited<ReturnType<typeof signedProvider>>;
  contextLogin: (options?: LoginOptions) => Promise<Awaited<ReturnType<typeof contextLogin>>>;
}>({
  boot: bootFixture(),
  provider: [
    async ({ task: _task }, use) => {
      const provider = await signedProvider();
      await use(provider);
      await provider.close();
    },
    { scope: "worker" },
  ],
  contextLogin: async ({ boot, provider }, use) => {
    await use((options = {}) => contextLogin(boot, provider, options));
    vi.useRealTimers();
  },
});

type LoginContext = { tenant: string };
type LoginOptions = {
  parameters?: Record<string, string>;
  allowedParameters?: readonly string[];
  resolvedTenant?: string;
  withoutContext?: boolean;
  rejectPrincipal?: boolean;
  clientId?: string;
  asyncResolve?: boolean;
  refuseResolve?: boolean;
  redirectUri?: (tenant: string) => string;
  postLogoutRedirectUri?: (tenant: string) => string;
};

class AllowedTenants extends Port("OidcContextAllowedTenants")<readonly string[]> {}

async function contextLogin(
  boot: Boot,
  provider: Awaited<ReturnType<typeof signedProvider>>,
  options: LoginOptions,
) {
  const clientId = options.clientId ?? `context-${randomUUID()}`;
  const { redirectUri, postLogoutRedirectUri } = options;
  const rows = new Map<string, StoredOidcTokens>();
  const changes: string[] = [];
  const admitted: LoginContext[] = [];
  const resolved: string[] = [];
  let codec: SessionCodecService | undefined;
  const store: OidcTokenStoreService = {
    create: (reference, record) => {
      changes.push("create");
      rows.set(reference, record);
      return OkAsync();
    },
    transact: (reference, work) =>
      work(rows.get(reference))
        .tap(({ record }) => {
          changes.push(record === undefined ? "delete" : "replace");
          if (record === undefined) rows.delete(reference);
          else rows.set(reference, record);
        })
        .flatMap(({ value }) => Ok(value)),
  };
  const pins = {
    issuer: provider.issuer,
    clientId,
    clientSecret: "context-secret",
  };
  const app = boot(
    Module("OidcLoginContextFixture")({
      imports: [httpServer({ port: 0, hostname: "127.0.0.1" })],
      provides: [
        sessionCodec({ keys: [Buffer.alloc(32, 7).toString("base64url")] }),
        Provider(AllowedTenants)({ inject: {}, value: ["alpha", "beta"] }),
        Provider(OidcTokenStore)({ inject: {}, value: store }),
        oidcTokens(pins),
        Provider.member(HttpHandler)({
          inject: { session: SessionCodec },
          sync: ({ session }) => {
            codec = session;
            return {
              prefix: "/session",
              handle: async (request, response) => {
                const value = request.headers.cookie?.split("__Host-session=")[1];
                const current = await session.unseal(value).get();
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(current?.principal ?? null));
              },
            };
          },
        }),
        ...(options.withoutContext
          ? oidc()({
              ...pins,
              redirectUri: "https://app.example/auth/callback",
              tokens: OidcTokens,
              principal: (claims) => ({ subject: claims.sub }),
            })
          : oidc<{ subject: string; tenant: string }, LoginContext>()({
              ...pins,
              ...(redirectUri === undefined
                ? { redirectUri: "https://app.example/auth/callback" }
                : {}),
              tokens: OidcTokens,
              inject: { tenants: AllowedTenants },
              loginContext: {
                schema: z.object({ tenant: z.string().min(1).max(3000) }),
                resolve: (metadata, services) => {
                  if (options.refuseResolve) return Err(new OidcLoginRefused());
                  const tenant =
                    options.resolvedTenant ??
                    new URL(metadata.url ?? "/", "https://app.example").searchParams.get("tenant");
                  resolved.push(metadata.method ?? "");
                  const value =
                    tenant !== null &&
                    (options.resolvedTenant !== undefined || services.tenants.includes(tenant))
                      ? { tenant }
                      : undefined;
                  return options.asyncResolve ? OkAsync(value) : Ok(value);
                },
                allowedParameters: options.allowedParameters ?? ["connection", "prompt"],
                authorizationParameters: (context) =>
                  options.parameters ?? { connection: `${context.tenant}-idp`, prompt: "login" },
                ...(redirectUri === undefined
                  ? {}
                  : { redirectUri: (context: LoginContext) => redirectUri(context.tenant) }),
                ...(postLogoutRedirectUri === undefined
                  ? {}
                  : {
                      postLogoutRedirectUri: (context: LoginContext) =>
                        postLogoutRedirectUri(context.tenant),
                    }),
              },
              principal: (claims, _services, context) => {
                admitted.push(context);
                return options.rejectPrincipal || claims["tenant"] !== context.tenant
                  ? undefined
                  : { subject: claims.sub, tenant: context.tenant };
              },
            })),
      ],
      exports: [HttpRuntime, HttpHandler],
    }),
  );
  const info = await app.runtimeInfo().get();
  assert.ok(info !== undefined && codec !== undefined);
  const boundCodec = codec;
  const origin = `http://127.0.0.1:${info.port}`;
  const cookies = new Map<string, string>();
  // An absolute URL is delivered to this server under its own `Host`, the way a
  // browser addressing that host would deliver it — or, given `proxyHost`, as a
  // forward proxy's absolute-form target under that other `Host`.
  const go = async (path: string, method = "GET", proxyHost?: string) => {
    const addressed = new URL(path, origin);
    const result = await new Promise<IncomingMessage>((resolve, reject) => {
      request(
        origin,
        {
          method,
          path:
            proxyHost === undefined ? `${addressed.pathname}${addressed.search}` : addressed.href,
          headers: {
            host: proxyHost ?? addressed.host,
            "sec-fetch-site": "same-origin",
            cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          },
        },
        resolve,
      )
        .on("error", reject)
        .end();
    });
    const setCookies = result.headers["set-cookie"] ?? [];
    for (const cookie of setCookies) {
      const [entry] = cookie.split(";");
      assert.ok(entry !== undefined);
      const offset = entry.indexOf("=");
      cookies.set(entry.slice(0, offset), entry.slice(offset + 1));
    }
    return {
      status: result.statusCode,
      location: result.headers.location ?? null,
      cookies: setCookies,
      body: await text(result),
    };
  };
  const begin = (tenant = "alpha") => go(`/auth/login?tenant=${encodeURIComponent(tenant)}`);
  const authorize = async (location: string | null, tenant = "alpha", trusted = true) => {
    assert.ok(location !== null);
    const url = new URL(location);
    url.searchParams.set("identity_tenant", tenant);
    url.searchParams.set("trusted", String(trusted));
    const result = await fetch(url, { redirect: "manual" });
    return result.headers.get("location") ?? "https://invalid.example";
  };
  const login = async (requested = "alpha", authenticated = requested) => {
    const begun = await begin(requested);
    return go(await authorize(begun.location, authenticated));
  };
  const transient = async () => {
    const state = await boundCodec.transient.unseal(cookies.get("__Host-oidc")).get();
    assert.ok(state !== undefined);
    return state;
  };
  return {
    begin,
    authorize,
    go,
    login,
    cookies,
    transient,
    codec: boundCodec,
    rows,
    changes,
    admitted,
    resolved,
    exchanges: () =>
      provider.exchanges
        .filter((exchange) => exchange.client === clientId)
        .map(({ authorize, token }) => ({ authorize, token })),
    logout: () => go("/auth/logout", "POST"),
    replaceTransient: async (state: Readonly<Record<string, string>>) => {
      cookies.set("__Host-oidc", await boundCodec.transient.seal(state).get());
    },
  };
}

async function signedProvider() {
  const signer = await generateKeyPair("ES256");
  const untrusted = await generateKeyPair("ES256");
  const jwk = await exportJWK(signer.publicKey);
  const codes = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      client: string;
      tenant: string;
      trusted: boolean;
      redirect: string;
    }
  >();
  const exchanges: { client: string; authorize: string; token: string | null }[] = [];
  let issuer = "";
  const server = createServer((request, response) => {
    void (async () => {
      const target = new URL(request.url ?? "/", issuer);
      if (target.pathname === "/.well-known/openid-configuration") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            end_session_endpoint: `${issuer}/logout`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["ES256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
          }),
        );
      } else if (target.pathname === "/jwks") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [jwk] }));
      } else if (target.pathname === "/authorize") {
        const code = randomUUID();
        codes.set(code, {
          nonce: target.searchParams.get("nonce") ?? "",
          challenge: target.searchParams.get("code_challenge") ?? "",
          client: target.searchParams.get("client_id") ?? "",
          tenant: target.searchParams.get("identity_tenant") ?? "",
          trusted: target.searchParams.get("trusted") !== "false",
          redirect: target.searchParams.get("redirect_uri") ?? "",
        });
        const callback = new URL(
          target.searchParams.get("redirect_uri") ?? "https://invalid.example",
        );
        callback.searchParams.set("state", target.searchParams.get("state") ?? "");
        callback.searchParams.set("code", code);
        response.writeHead(303, { location: callback.href });
        response.end();
      } else if (target.pathname === "/token") {
        const parameters = new URLSearchParams(await text(request));
        const code = parameters.get("code") ?? "";
        const held = codes.get(code);
        codes.delete(code);
        if (held !== undefined)
          exchanges.push({
            client: held.client,
            authorize: held.redirect,
            token: parameters.get("redirect_uri"),
          });
        const challenge = createHash("sha256")
          .update(parameters.get("code_verifier") ?? "")
          .digest("base64url");
        response.setHeader("content-type", "application/json");
        if (
          held === undefined ||
          held.challenge !== challenge ||
          held.redirect !== parameters.get("redirect_uri")
        ) {
          response.writeHead(400);
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const token = await new SignJWT({ nonce: held.nonce, tenant: held.tenant })
          .setProtectedHeader({ alg: "ES256" })
          .setIssuer(issuer)
          .setAudience(held.client)
          .setSubject(`${held.tenant}-account`)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(held.trusted ? signer.privateKey : untrusted.privateKey);
        response.end(
          JSON.stringify({
            access_token: "context-access",
            token_type: "Bearer",
            expires_in: 300,
            id_token: token,
          }),
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    })().catch((cause: unknown) => response.destroy(cause instanceof Error ? cause : undefined));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    exchanges,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
