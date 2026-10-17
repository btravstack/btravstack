import { ConfigInvalid } from "@btravstack/config";
import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { ORY_ISSUER } from "@btravstack/internal-test-infra/ory";
import { OkAsync, allAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { AUDIENCE, SCOPE, it } from "./__tests__/test-fixtures.js";
import { TokenIssuerUnavailable, TokenRefused, TokenSource } from "./token-source.js";

const UNREACHABLE = "https://127.0.0.1:1/";

// Hydra answers `expires_in: 3599` or `3600` depending on where in a second it
// minted, so a minute before expiry is somewhere in this window.
const BEFORE_SKEW_MS = 3_538_000;
const AFTER_SKEW_MS = 3_541_000;

describe("oauthClient", () => {
  describe("token exchange", () => {
    it("snapshots every request field before discovery so mutation cannot poison a subject's cache", async ({
      tokens,
      scripted,
      observations,
    }) => {
      // GIVEN a mutable request and discovery held at the HTTP boundary
      const issuer = scripted.controlled;
      const env = {
        OAUTH_ISSUER: issuer.issuer,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };
      const actor = { token: "alice-actor", tokenType: "actor-type" };
      const subject = { token: "alice", tokenType: "subject-type", actor };
      const request = { audience: "orders", scope: "read", onBehalfOf: subject };

      // WHEN the caller mutates fields and replaces nested records while discovery waits
      const answer = await tokens({ env }, (ctx) =>
        fromSafePromise(
          (async () => {
            const source = ctx.get(TokenSource);
            const pending = source.token(request);
            await issuer.discoveryReached;
            request.audience = "billing";
            request.scope = "write";
            subject.token = "bob";
            subject.tokenType = "changed-subject-type";
            actor.token = "bob-actor";
            actor.tokenType = "changed-actor-type";
            subject.actor = { token: "replacement-actor", tokenType: "replacement-actor-type" };
            request.onBehalfOf = {
              token: "replacement",
              tokenType: "replacement-type",
              actor: subject.actor,
            };
            issuer.releaseDiscovery();
            const grant = await issuer.nextGrant();
            grant.succeed();
            const first = (await pending).getOrThrow();
            const cached = (
              await source.token({
                audience: "orders",
                scope: "read",
                onBehalfOf: {
                  token: "alice",
                  tokenType: "subject-type",
                  actor: { token: "alice-actor", tokenType: "actor-type" },
                },
              })
            ).getOrThrow();
            return {
              bearer: first.bearer,
              reused: first.bearer === cached.bearer,
              fetches: observations.length,
            };
          })(),
        ),
      );

      // THEN the cached token belongs to the complete original credential and request
      expect(answer).toBeOkWith({
        bearer: JSON.stringify({
          audience: "orders",
          scope: "read",
          subject_token: "alice",
          subject_token_type: "subject-type",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          actor_token: "alice-actor",
          actor_token_type: "actor-type",
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        }),
        reused: true,
        fetches: 1,
      });
    });

    it("keeps an initially service-only request service-only when the caller later adds delegation", async ({
      tokens,
      scripted,
    }) => {
      // GIVEN a service request with absent optional fields
      const issuer = scripted.controlled;
      const env = {
        OAUTH_ISSUER: issuer.issuer,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };
      const request: {
        audience: string;
        scope?: string;
        onBehalfOf?: { token: string; tokenType: string };
      } = { audience: "orders" };

      // WHEN optional fields are added before discovery completes
      const answer = await tokens({ env }, (ctx) =>
        fromSafePromise(
          (async () => {
            const pending = ctx.get(TokenSource).token(request);
            await issuer.discoveryReached;
            request.scope = "write";
            request.onBehalfOf = { token: "bob", tokenType: "subject-type" };
            issuer.releaseDiscovery();
            const grant = await issuer.nextGrant();
            grant.succeed();
            return (await pending).getOrThrow();
          })(),
        ),
      );

      // THEN the original request still uses client credentials without a scope
      expect(answer).toBeOkWith({
        bearer: JSON.stringify({ audience: "orders", grant_type: "client_credentials" }),
      });
    });

    it("authenticates the service and preserves the subject with the issuer's actor claim", async ({
      tokens,
      exchange,
    }) => {
      // GIVEN a real issuer permitting the gateway to exchange Alice's token
      // WHEN the source is asked on Alice's behalf
      const answer = await tokens({ env: exchange.env }, (ctx) =>
        ctx
          .get(TokenSource)
          .token({ audience: "orders", onBehalfOf: exchange.alice })
          .flatMap(({ bearer }) => fromSafePromise(exchange.introspect(bearer))),
      );

      // THEN the issuer minted an active delegated token, rather than a service token
      expect(answer).toBeOkWith(
        expect.objectContaining({
          active: true,
          aud: "orders",
          act: { sub: exchange.actorId, client_id: "gateway" },
          preferred_username: "alice",
        }),
      );
    });

    it("keeps different subjects and the service's own token apart", async ({
      tokens,
      exchange,
      observations,
    }) => {
      // GIVEN one source serving two subjects and itself
      // WHEN each asks for the same audience
      const answer = await tokens({ env: exchange.env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return source.token({ audience: "orders", onBehalfOf: exchange.alice }).flatMap((alice) =>
          source.token({ audience: "orders", onBehalfOf: exchange.bob }).flatMap((bob) =>
            source.token({ audience: "orders" }).flatMap((service) =>
              source.token({ audience: "orders", onBehalfOf: exchange.alice }).map((cached) => ({
                distinct: new Set([alice.bearer, bob.bearer, service.bearer]).size,
                same: cached.bearer === alice.bearer,
                fetches: observations.length,
              })),
            ),
          ),
        );
      });

      // THEN subject credentials separate caches and the repeated request reuses Alice's token
      expect(answer).toBeOkWith({ distinct: 3, same: true, fetches: 3 });
    });

    it("shares one exchange among simultaneous callers for a subject", async ({
      tokens,
      exchange,
      observations,
    }) => {
      // GIVEN an uncached subject
      // WHEN two callers ask simultaneously
      const answer = await tokens({ env: exchange.env }, (ctx) =>
        allAsync([
          ctx.get(TokenSource).token({ audience: "orders", onBehalfOf: exchange.alice }),
          ctx.get(TokenSource).token({ audience: "orders", onBehalfOf: exchange.alice }),
        ]).map((answers) => ({
          distinct: new Set(answers.map(({ bearer }) => bearer)).size,
          fetches: observations.length,
        })),
      );

      // THEN the exchange is single flight
      expect(answer).toBeOkWith({ distinct: 1, fetches: 1 });
    });

    it("refuses delegation without an actor token when the issuer requires it", async ({
      tokens,
      exchange,
    }) => {
      // GIVEN a subject authorized for native delegation
      const { actor: _actor, ...subject } = exchange.alice;

      // WHEN the required actor credential is omitted
      const answer = await tokens({ env: exchange.env }, (ctx) =>
        ctx.get(TokenSource).token({ audience: "orders", onBehalfOf: subject }),
      );

      // THEN it cannot silently become an impersonation grant
      expect(answer).toBeErrWith(
        expect.objectContaining({ constructor: TokenRefused, error: "invalid_request" }),
      );
    });

    it("keeps subject credentials out of observation details", async ({
      tokens,
      exchange,
      observations,
    }) => {
      // GIVEN subject and actor credentials passed to the real issuer
      // WHEN their exchange is observed
      const answer = await tokens({ env: exchange.env }, (ctx) =>
        ctx
          .get(TokenSource)
          .token({ audience: "orders", onBehalfOf: exchange.alice })
          .map(() => observations),
      );

      // THEN telemetry carries audience and scope only
      expect(answer).toBeOkWith([
        {
          operation: {
            component: "oauth-client",
            name: "token",
            attributes: { operation: "token", "btravstack.oauth.audience": "orders" },
            details: { "btravstack.oauth.scope": "" },
          },
          settled: { outcome: "ok" },
        },
      ]);
    });

    it("evicts the oldest token when subject turnover reaches the fixed capacity", async ({
      tokens,
      scripted,
      observations,
    }) => {
      // GIVEN an issuer boundary returning a new token for each cache miss
      const env = {
        OAUTH_ISSUER: scripted.issuing,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };
      const subject = (token: string) => ({
        audience: "orders",
        onBehalfOf: { token, tokenType: "urn:ietf:params:oauth:token-type:access_token" },
      });

      // WHEN more subjects than the cache can retain are fetched, then the newest and oldest are asked again
      const answer = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return source.token(subject("first")).flatMap((first) =>
          Array.from({ length: 1024 }, (_, i) => i)
            .reduce<ReturnType<typeof source.token>>(
              (previous, i) => previous.flatMap(() => source.token(subject(`subject-${i}`))),
              OkAsync(first),
            )
            .flatMap((last) =>
              source.token(subject("subject-1023")).flatMap((newest) =>
                source.token(subject("first")).map((oldest) => ({
                  oldestReused: oldest.bearer === first.bearer,
                  newestReused: newest.bearer === last.bearer,
                  fetches: observations.length,
                })),
              ),
            ),
        );
      });

      // THEN the cache retains recent tokens without growing for every subject forever
      expect(answer).toBeOkWith({ oldestReused: false, newestReused: true, fetches: 1026 });
    });

    it("recovers health when a refused subject is replaced with a valid credential", async ({
      tokens,
      exchange,
    }) => {
      // GIVEN a subject credential the issuer refuses
      // WHEN that audience is fetched again with the subject's valid replacement
      const answer = await tokens({ env: exchange.env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return fromSafePromise(
          source
            .token({ audience: "orders", onBehalfOf: { ...exchange.alice, token: "invalid" } })
            .getOrUndefined(),
        )
          .flatMap(() => source.token({ audience: "orders", onBehalfOf: exchange.alice }))
          .flatMap(() => runHealthChecks(ctx.get(HealthChecks)));
      });

      // THEN the obsolete credential's failure no longer poisons the component
      expect(answer).toBeOkWith({
        status: "healthy",
        components: [{ name: "oauth-client", status: "healthy" }],
      });
    });

    it("reports an invalid subject as a typed refusal instead of issuing a service token", async ({
      tokens,
      exchange,
    }) => {
      // GIVEN credentials that cannot identify a subject
      // WHEN the gateway asks on that subject's behalf
      const answer = await tokens({ env: exchange.env }, (ctx) =>
        ctx
          .get(TokenSource)
          .token({ audience: "orders", onBehalfOf: { ...exchange.alice, token: "invalid" } }),
      );

      // THEN the issuer's refusal is retained
      expect(answer).toBeErrWith(
        expect.objectContaining({
          constructor: TokenRefused,
          audience: "orders",
          error: "invalid_request",
        }),
      );
    });
  });

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

    it("is kept apart for an absent scope and an empty one", async ({
      tokens,
      env,
      observations,
    }) => {
      // GIVEN a token fetched with no scope
      // WHEN one is asked for with an explicitly empty scope
      const fetches = await tokens({ env }, (ctx) => {
        const source = ctx.get(TokenSource);
        return fromSafePromise(source.token({ audience: AUDIENCE }).getOrUndefined())
          .flatMap(() =>
            fromSafePromise(source.token({ audience: AUDIENCE, scope: "" }).getOrUndefined()),
          )
          .map(() => observations.length);
      });

      // THEN the second was a fetch of its own, not the first one's token
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

    it("is TokenRefused, invalid_client, for a Basic-auth challenge", async ({
      tokens,
      scripted,
    }) => {
      // GIVEN an issuer that answers a wrong client with a WWW-Authenticate challenge
      const env = {
        OAUTH_ISSUER: scripted.challenging,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };

      // WHEN a token is asked for
      const answer = await tokens({ env }, (ctx) =>
        ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN it is a refusal, not an outage
      expect(answer).toBeErrWith(
        expect.objectContaining({ constructor: TokenRefused, error: "invalid_client" }),
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

    it("is TokenIssuerUnavailable, not a refusal, for a token endpoint answering 5xx", async ({
      tokens,
      scripted,
    }) => {
      // GIVEN an issuer whose token endpoint answers 503 with an OAuth error body
      const env = {
        OAUTH_ISSUER: scripted.failing,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };

      // WHEN a token is asked for
      const answer = await tokens({ env }, (ctx) =>
        ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN the outage is not mistaken for a refusal
      expect(answer).toBeErrWith(
        expect.objectContaining({ constructor: TokenIssuerUnavailable, issuer: scripted.failing }),
      );
    });

    it("is TokenIssuerUnavailable, not a throw, for a pinned empty secret", async ({
      tokens,
      client,
    }) => {
      // GIVEN a secret pinned empty, which a pin does not validate
      // WHEN a token is asked for
      const answer = await tokens(
        { env: {}, issuer: ORY_ISSUER, clientId: client.clientId, clientSecret: "" },
        (ctx) => ctx.get(TokenSource).token({ audience: AUDIENCE }),
      );

      // THEN the failure arrives on the error channel
      expect(answer).toBeErrWith(
        expect.objectContaining({ constructor: TokenIssuerUnavailable, issuer: ORY_ISSUER }),
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
    it("keeps a fresh generation after the newest fetch settled while an older fetch is still pending", async ({
      tokens,
      scripted,
    }) => {
      // GIVEN an old request pending across a successful replacement
      const issuer = scripted.controlled;
      const env = {
        OAUTH_ISSUER: issuer.issuer,
        OAUTH_CLIENT_ID: "client",
        OAUTH_CLIENT_SECRET: "secret",
      };
      issuer.releaseDiscovery();

      // WHEN another fetch starts after that replacement and the old request completes before it
      const report = await tokens({ env }, (ctx) =>
        fromSafePromise(
          (async () => {
            const source = ctx.get(TokenSource);
            const request = (token: string) => ({
              audience: "orders",
              onBehalfOf: { token, tokenType: "subject-type" },
            });
            const older = source.token(request("old"));
            const oldGrant = await issuer.nextGrant();
            const replacement = source.token(request("replacement"));
            (await issuer.nextGrant()).succeed();
            await replacement;
            const fresh = source.token(request("fresh"));
            const freshGrant = await issuer.nextGrant();
            oldGrant.succeed();
            await older;
            freshGrant.refuse();
            await fresh;
            return (await runHealthChecks(ctx.get(HealthChecks))).get();
          })(),
        ),
      );

      // THEN cleanup of earlier fetches cannot remove or reuse the fresh generation
      expect(report).toBeOkWith({
        status: "unhealthy",
        components: [
          {
            name: "oauth-client",
            status: "unhealthy",
            reason: "orders: refused (invalid_request)",
          },
        ],
      });
    });

    for (const { olderFails, newestFirst } of [
      { olderFails: true, newestFirst: true },
      { olderFails: true, newestFirst: false },
      { olderFails: false, newestFirst: true },
      { olderFails: false, newestFirst: false },
    ])
      it(`keeps the newest-started fetch's health when olderFails=${olderFails} and newestFirst=${newestFirst}`, async ({
        tokens,
        scripted,
      }) => {
        // GIVEN two different credentials fetching the same audience and scope
        const issuer = scripted.controlled;
        const env = {
          OAUTH_ISSUER: issuer.issuer,
          OAUTH_CLIENT_ID: "client",
          OAUTH_CLIENT_SECRET: "secret",
        };
        issuer.releaseDiscovery();

        // WHEN their responses finish in either order
        const report = await tokens({ env }, (ctx) =>
          fromSafePromise(
            (async () => {
              const source = ctx.get(TokenSource);
              const older = source.token({
                audience: "orders",
                scope: "read",
                onBehalfOf: { token: "old", tokenType: "subject-type" },
              });
              const oldGrant = await issuer.nextGrant();
              const newer = source.token({
                audience: "orders",
                scope: "read",
                onBehalfOf: { token: "new", tokenType: "subject-type" },
              });
              const newGrant = await issuer.nextGrant();
              const finishOld = () => (olderFails ? oldGrant.refuse() : oldGrant.succeed());
              const finishNew = () => (olderFails ? newGrant.succeed() : newGrant.refuse());
              if (newestFirst) {
                finishNew();
                await newer;
                finishOld();
                await older;
              } else {
                finishOld();
                await older;
                finishNew();
                await newer;
              }
              return (await runHealthChecks(ctx.get(HealthChecks))).get();
            })(),
          ),
        );

        // THEN only the latest-started credential determines this pair's health
        expect(report).toBeOkWith(
          olderFails
            ? {
                status: "healthy",
                components: [{ name: "oauth-client", status: "healthy" }],
              }
            : {
                status: "unhealthy",
                components: [
                  {
                    name: "oauth-client",
                    status: "unhealthy",
                    reason: "orders: refused (invalid_request)",
                  },
                ],
              },
        );
      });

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

describe("application fetch boundary", () => {
  it("uses the composed fetch for both discovery and the credential-bearing grant", async ({
    tokens,
    scripted,
  }) => {
    // GIVEN
    const requests: { method: string | undefined; credential: boolean }[] = [];
    const transport: typeof fetch = (url, options) => {
      requests.push({
        method: options?.method,
        credential: new Headers(options?.headers).has("authorization"),
      });
      return fetch(url, options);
    };
    // WHEN
    const result = await tokens(
      {
        env: {
          OAUTH_ISSUER: scripted.issuing,
          OAUTH_CLIENT_ID: "client",
          OAUTH_CLIENT_SECRET: "secret",
        },
        fetch: transport,
      },
      (ctx) => ctx.get(TokenSource).token({ audience: "orders" }),
    );
    // THEN
    expect(result.map(({ bearer }) => ({ bearer, requests }))).toBeOkWith({
      bearer: "test-bearer-1",
      requests: [
        { method: "GET", credential: false },
        { method: "POST", credential: true },
      ],
    });
  });
});
