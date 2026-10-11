import { ConfigInvalid } from "@btravstack/config";
import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { ORY_ISSUER } from "@btravstack/internal-test-infra/ory";
import { allAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { AUDIENCE, SCOPE, it } from "./__tests__/test-fixtures.js";
import { TokenIssuerUnavailable, TokenRefused, TokenSource } from "./token-source.js";

const UNREACHABLE = "https://127.0.0.1:1/";

// Hydra answers `expires_in: 3599` or `3600` depending on where in a second it
// minted, so a minute before expiry is somewhere in this window.
const BEFORE_SKEW_MS = 3_538_000;
const AFTER_SKEW_MS = 3_541_000;

describe("oauthClient", () => {
  describe("a token", () => {
    it("is one the issuer introspects as active for the audience and scope", async ({
      tokens,
      env,
      client,
      introspect,
    }) => {
      // GIVEN a client allowed the audience and the scope
      // WHEN it asks for a token for both
      const introspected = await tokens({ env }, (ctx) =>
        ctx
          .get(TokenSource)
          .token({ audience: AUDIENCE, scope: SCOPE })
          .flatMap(({ bearer }) => fromSafePromise(introspect(bearer))),
      );

      // THEN Hydra issued it, to this client, for exactly that
      expect(introspected).toBeOkWith(
        expect.objectContaining({
          active: true,
          aud: [AUDIENCE],
          client_id: client.clientId,
          scope: SCOPE,
        }),
      );
    });

    it("is served from memory while it lives, so the issuer is asked once", async ({
      tokens,
      env,
      observations,
      clock,
    }) => {
      // GIVEN a token already fetched
      // WHEN the same one is asked for again, most of its lifetime later
      const seen = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return source.token({ audience: AUDIENCE }).flatMap((first) =>
          clock
            .advance(BEFORE_SKEW_MS)
            .flatMap(() => source.token({ audience: AUDIENCE }))
            .map((second) => ({
              same: second.bearer === first.bearer,
              fetches: observations.length,
            })),
        );
      });

      // THEN the second is the first, and only one fetch was made
      expect(seen).toBeOkWith({ same: true, fetches: 1 });
    });

    it("is fetched again a minute before it expires", async ({
      tokens,
      env,
      observations,
      clock,
    }) => {
      // GIVEN a token already fetched
      // WHEN it is asked for again inside the last minute of its lifetime
      const seen = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return source.token({ audience: AUDIENCE }).flatMap((first) =>
          clock
            .advance(AFTER_SKEW_MS)
            .flatMap(() => source.token({ audience: AUDIENCE }))
            .map((second) => ({
              same: second.bearer === first.bearer,
              fetches: observations.length,
            })),
        );
      });

      // THEN a new one was fetched rather than one about to lapse handed out
      expect(seen).toBeOkWith({ same: false, fetches: 2 });
    });

    it("is kept per audience and scope, so a different scope is a fetch of its own", async ({
      tokens,
      env,
      observations,
    }) => {
      // GIVEN a token for the audience without a scope
      // WHEN the same audience is asked for with one
      const fetches = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return source
          .token({ audience: AUDIENCE })
          .flatMap(() => source.token({ audience: AUDIENCE, scope: SCOPE }))
          .map(() => observations.length);
      });

      // THEN both were fetched
      expect(fetches).toBeOkWith(2);
    });

    it("is fetched once for callers that ask at the same time", async ({
      tokens,
      env,
      observations,
    }) => {
      // GIVEN nothing fetched yet
      // WHEN five callers ask for the same token together
      const seen = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return allAsync(
          [1, 2, 3, 4, 5].map(() => source.token({ audience: AUDIENCE, scope: SCOPE })),
        ).map((answers) => ({
          distinct: new Set(answers.map(({ bearer }) => bearer)).size,
          fetches: observations.length,
        }));
      });

      // THEN one request was made, and all five hold its answer
      expect(seen).toBeOkWith({ distinct: 1, fetches: 1 });
    });
  });

  describe("a refusal", () => {
    it("is TokenRefused, invalid_client, for a wrong secret", async ({ tokens, env }) => {
      // GIVEN a deployment holding a secret the issuer does not know
      const wrong = { ...env, OAUTH_CLIENT_SECRET: "not-the-secret" };

      // WHEN it asks for a token
      const answer = await tokens({ env: wrong }, (ctx) =>
        ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN the issuer's own code says why, and the secret is nowhere on it
      expect(answer).toBeErrWith(
        expect.objectContaining({
          constructor: TokenRefused,
          audience: AUDIENCE,
          error: "invalid_client",
          description: expect.not.stringContaining("not-the-secret"),
        }),
      );
    });

    it("is TokenRefused, invalid_request, for an audience the client was not granted", async ({
      tokens,
      env,
    }) => {
      // GIVEN a client allowed only AUDIENCE
      // WHEN it asks for another
      const answer = await tokens({ env }, (ctx) =>
        ctx.get(TokenSource).token({ audience: "https://elsewhere.example.test" }),
      );

      // THEN the issuer refused it
      expect(answer).toBeErrWith(
        expect.objectContaining({
          constructor: TokenRefused,
          audience: "https://elsewhere.example.test",
          error: "invalid_request",
        }),
      );
    });

    it("is TokenRefused, invalid_scope, for a scope the client was not granted", async ({
      tokens,
      env,
    }) => {
      // GIVEN a client granted only SCOPE
      // WHEN it asks for another
      const answer = await tokens({ env }, (ctx) =>
        ctx.get(TokenSource).token({ audience: AUDIENCE, scope: "orders:write" }),
      );

      // THEN the issuer refused it
      expect(answer).toBeErrWith(
        expect.objectContaining({ constructor: TokenRefused, error: "invalid_scope" }),
      );
    });
  });

  describe("an issuer that cannot be asked", () => {
    it("is TokenIssuerUnavailable, naming the issuer", async ({ tokens }) => {
      // GIVEN an issuer nothing listens at
      const env = {
        OAUTH_ISSUER: UNREACHABLE,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };

      // WHEN a token is asked for
      const answer = await tokens({ env }, (ctx) =>
        ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN the outage is told apart from a refusal
      expect(answer).toBeErrWith(
        expect.objectContaining({ constructor: TokenIssuerUnavailable, issuer: UNREACHABLE }),
      );
    });

    it("is asked again by the next caller, because a failure is never kept", async ({
      tokens,
      observations,
    }) => {
      // GIVEN an issuer nothing listens at, already failed once
      const env = {
        OAUTH_ISSUER: UNREACHABLE,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };

      // WHEN a token is asked for again
      const outcomes = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return fromSafePromise(source.token({ audience: AUDIENCE }).getOrUndefined())
          .flatMap(() => fromSafePromise(source.token({ audience: AUDIENCE }).getOrUndefined()))
          .map(() => observations.map(({ settled }) => settled?.outcome));
      });

      // THEN each call made a fetch of its own, and each failed
      expect(outcomes).toBeOkWith(["error", "error"]);
    });
  });

  describe("observation", () => {
    it("reports a fetch with the audience as a dimension and the scope as a detail", async ({
      tokens,
      env,
      observations,
    }) => {
      // GIVEN a source and an observer
      // WHEN one token is fetched
      const seen = await tokens({ env }, (ctx) =>
        ctx
          .get(TokenSource)
          .token({ audience: AUDIENCE, scope: SCOPE })
          .map(() => observations),
      );

      // THEN the observer saw one operation, settled ok
      expect(seen).toBeOkWith([
        {
          operation: {
            component: "oauth-client",
            name: "token",
            attributes: { operation: "token", "btravstack.oauth.audience": AUDIENCE },
            details: { "btravstack.oauth.scope": SCOPE },
          },
          settled: { outcome: "ok" },
        },
      ]);
    });
  });

  describe("the health check", () => {
    it("is healthy once a token was fetched", async ({ tokens, env }) => {
      // GIVEN a source that has fetched a token
      // WHEN the kernel runs the health checks
      const report = await tokens({ env }, (ctx) =>
        ctx
          .get(TokenSource)
          .token({ audience: AUDIENCE })
          .flatMap(() => runHealthChecks(ctx.get(HealthChecks))),
      );

      // THEN oauth-client is healthy
      expect(report).toBeOkWith({
        status: "healthy",
        components: [{ name: "oauth-client", status: "healthy" }],
      });
    });

    it("fails while an audience's last fetch failed, saying why", async ({ tokens, env }) => {
      // GIVEN a fetch the issuer refused
      // WHEN the kernel runs the health checks
      const report = await tokens({ env }, (ctx) =>
        fromSafePromise(
          ctx
            .get(TokenSource)
            .token({ audience: AUDIENCE, scope: "orders:write" })
            .getOrUndefined(),
        ).flatMap(() => runHealthChecks(ctx.get(HealthChecks))),
      );

      // THEN the reason names the audience and the issuer's code
      expect(report).toBeOkWith({
        status: "unhealthy",
        components: [
          {
            name: "oauth-client",
            status: "unhealthy",
            reason: `${AUDIENCE}: refused (invalid_scope)`,
          },
        ],
      });
    });
  });

  describe("configuration", () => {
    it("names every missing variable at once", async ({ tokens }) => {
      // GIVEN an environment that sets none of the three
      // WHEN the graph is built
      const built = await tokens({ env: {} }, () => fromSafePromise(Promise.resolve()));

      // THEN one ConfigInvalid names all three
      expect(built).toBeErrWith(
        expect.objectContaining({
          constructor: ConfigInvalid,
          issues: [
            expect.objectContaining({ path: ["OAUTH_ISSUER"] }),
            expect.objectContaining({ path: ["OAUTH_CLIENT_ID"] }),
            expect.objectContaining({ path: ["OAUTH_CLIENT_SECRET"] }),
          ],
        }),
      );
    });

    it("refuses a cleartext issuer that leaves the machine", async ({ tokens }) => {
      // GIVEN an http: issuer on a host that is not loopback
      const env = {
        OAUTH_ISSUER: "http://issuer.internal/",
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };

      // WHEN the graph is built
      const built = await tokens({ env }, () => fromSafePromise(Promise.resolve()));

      // THEN the boot fails naming the variable, before a secret is sent anywhere
      expect(built).toBeErrWith(
        expect.objectContaining({
          constructor: ConfigInvalid,
          port: "OAuthClient",
          issues: [expect.objectContaining({ path: ["OAUTH_ISSUER"] })],
        }),
      );
    });

    it("takes a cleartext issuer off loopback when allowInsecureIssuer is pinned", async ({
      tokens,
    }) => {
      // GIVEN an http: issuer that is not loopback, and the opt-in pinned
      const env = {
        OAUTH_ISSUER: "http://issuer.invalid/",
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };

      // WHEN the graph is built and a token asked for
      const answer = await tokens({ env, allowInsecureIssuer: true }, (ctx) =>
        ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN the boot went through, and the issuer was asked — here, for a name that resolves nowhere
      expect(answer).toBeErrWith(
        expect.objectContaining({
          constructor: TokenIssuerUnavailable,
          issuer: "http://issuer.invalid/",
        }),
      );
    });

    it("takes its three values pinned, reading none of them", async ({ tokens, client }) => {
      // GIVEN every value pinned at the call, an empty environment, and no clock but the kernel's
      // WHEN a token is asked for
      const answer = await tokens(
        {
          env: {},
          issuer: ORY_ISSUER,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          clock: undefined,
        },
        (ctx) => ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN the pins were enough
      expect(answer).toBeOkWith({ bearer: expect.any(String) });
    });
  });
});
