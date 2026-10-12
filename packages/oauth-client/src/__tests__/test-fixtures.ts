import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Env, type ConfigInvalid, type Environment } from "@btravstack/config";
import {
  HealthChecks,
  Observers,
  type Operation,
  type Settle,
  type Settled,
} from "@btravstack/core";
import { Module, Provider, type Context } from "@btravstack/di";
import { createExchangeClient } from "@btravstack/internal-test-infra/keycloak";
import {
  ORY_ISSUER,
  createServiceClient,
  type OryServiceClient,
} from "@btravstack/internal-test-infra/ory";
import { createFakeClock, type FakeClock } from "@btravstack/testing";
import type { AsyncResult } from "unthrown";
import { test } from "vitest";

import { oauthClient, type OAuthClientOptions } from "../client.js";
import { TokenSource } from "../token-source.js";

/** The callee every provisioned client may ask a token for. */
export const AUDIENCE = "https://orders.example.test";

/** The one scope every provisioned client is granted. */
export const SCOPE = "orders:read";

/** One operation an observer was handed, with how it settled. */
export type Observation = {
  readonly operation: Operation;
  settled?: Settled;
};

/** A graph around `oauthClient(options)`, over the fixtures' clock and observer, run for the length of `body`. */
export type Tokens = <T, E>(
  options: OAuthClientOptions & { readonly env: Environment },
  body: (ctx: Context<TokenSource | HealthChecks>) => AsyncResult<T, E>,
) => AsyncResult<T, E | ConfigInvalid>;

export type OAuthFixtures = {
  readonly exchange: Awaited<ReturnType<typeof createExchangeClient>>;
  readonly clock: FakeClock;
  /** A client of this test's own, allowed {@link AUDIENCE} and {@link SCOPE}. */
  readonly client: OryServiceClient;
  /** The environment a deployment of {@link client} sets. */
  readonly env: Environment;
  /** Every fetch the source reported, in order. */
  readonly observations: Observation[];
  readonly tokens: Tokens;
  /** What Hydra says a token it issued is. */
  readonly introspect: (token: string) => Promise<unknown>;
  /**
   * Scripted issuers answering what the gate's Hydra never does: `challenging`
   * refuses every client as RFC 6749 §5.2 spells it for Basic authentication —
   * `401` with a `WWW-Authenticate` challenge — and `failing` answers every
   * token request with a `503` and an OAuth error body. `issuing` answers each
   * token request with a fresh bearer.
   */
  readonly scripted: {
    readonly challenging: string;
    readonly failing: string;
    readonly issuing: string;
  };
};

export const it = test.extend<OAuthFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- a fixture with no dependencies still takes vitest's destructured first parameter
  exchange: async ({}, use) => {
    await use(await createExchangeClient());
  },
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  clock: async ({}, use) => {
    await use(createFakeClock());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  client: async ({}, use) => {
    await use(await createServiceClient({ audience: [AUDIENCE], scope: SCOPE }));
  },
  env: async ({ client }, use) => {
    await use({
      OAUTH_ISSUER: ORY_ISSUER,
      OAUTH_CLIENT_ID: client.clientId,
      OAUTH_CLIENT_SECRET: client.clientSecret,
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  observations: async ({}, use) => {
    await use([]);
  },
  tokens: async ({ clock, observations }, use) => {
    const recorder = (operation: Operation): Settle => {
      const observation: Observation = { operation };
      observations.push(observation);
      return (settled) => {
        observation.settled = settled;
      };
    };
    await use(({ env, ...options }, body) =>
      Module.scoped(
        Module("Tokens")({
          imports: [oauthClient({ clock, ...options })],
          provides: [
            Provider(Env)({ inject: {}, value: env }),
            Provider.member(Observers)({ inject: {}, value: recorder }),
          ],
          exports: [TokenSource, HealthChecks],
        }),
        body,
      ),
    );
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  scripted: async ({}, use) => {
    let issued = 0;
    const server = createServer((request, response) => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const [, name, rest] = (request.url ?? "").split(/^\/(\w+)/);
      response.setHeader("content-type", "application/json");
      if (rest === "/.well-known/openid-configuration") {
        const issuer = `${base}/${name}`;
        response.end(JSON.stringify({ issuer, token_endpoint: `${issuer}/token` }));
        return;
      }
      if (name === "issuing") {
        issued += 1;
        response.end(
          JSON.stringify({
            access_token: `test-bearer-${issued}`,
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (name === "challenging") {
        response.statusCode = 401;
        response.setHeader("www-authenticate", 'Basic realm="challenging", error="invalid_client"');
        response.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "temporarily_unavailable" }));
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await use({
      challenging: `${base}/challenging`,
      failing: `${base}/failing`,
      issuing: `${base}/issuing`,
    });
    await new Promise((closed) => server.close(closed));
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  introspect: async ({}, use) => {
    await use(async (token) => {
      const response = await fetch("http://localhost:4445/admin/oauth2/introspect", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
      return response.json();
    });
  },
});
