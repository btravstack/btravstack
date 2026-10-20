import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("server-side oidc tokens", () => {
  it("keeps tokens out of the encrypted session payload", async ({ tokens }) => {
    // GIVEN a verified login response
    const cookie = await tokens.login();
    // WHEN the existing codec opens the browser cookie
    const session = await tokens.codec.unseal(cookie);
    // THEN only the principal, binding and opaque reference cross that boundary
    expect(session).toBeOkWith({
      principal: { userId: "alice" },
      iss: "https://issuer.example",
      clientId: "staff",
      tokenRef: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      iat: expect.any(Number),
      exp: expect.any(Number),
      typ: "session",
    });
  });

  it("resolves the current session token without refreshing a live token", async ({ tokens }) => {
    // GIVEN a live token in server storage
    const cookie = await tokens.login();
    // WHEN a downstream call needs its bearer
    const token = await tokens.service.accessToken(cookie);
    // THEN it receives its own token
    expect(token).toBeOkWith("access-alice");
  });

  it("refreshes an expired access token and persists rotation", async ({ tokens }) => {
    // GIVEN a token whose access lifetime has passed
    const cookie = await tokens.login();
    await tokens.clock.advance(60_000);
    // WHEN the session is used again
    await tokens.service.accessToken(cookie).getOrThrow();
    // THEN the store holds the replacement without extending the session lifetime
    expect([...tokens.rows.values()]).toEqual([
      expect.objectContaining({
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
        subject: "alice",
        sessionExpiresAt: expect.any(Number),
      }),
    ]);
  });

  it("serializes concurrent refreshes across two manager instances", async ({ tokens }) => {
    // GIVEN two replicas sharing the same store
    const cookie = await tokens.login();
    await tokens.clock.advance(60_000);
    const other = tokens.manager();
    // WHEN both request an expired token concurrently
    await Promise.all([
      tokens.service.accessToken(cookie).getOrThrow(),
      other.accessToken(cookie).getOrThrow(),
    ]);
    // THEN only one token request consumes the refresh token
    expect(tokens.calls.map((body) => new URLSearchParams(body).get("refresh_token"))).toEqual([
      "refresh-alice",
    ]);
  });

  it("preserves the previous refresh token when the issuer omits a replacement", async ({
    tokens,
  }) => {
    // GIVEN an issuer that does not rotate on this response
    const cookie = await tokens.login();
    tokens.respond({ access_token: "replacement", token_type: "Bearer", expires_in: 120 });
    await tokens.clock.advance(60_000);
    // WHEN refreshing
    await tokens.service.accessToken(cookie).getOrThrow();
    // THEN the existing refresh credential is retained
    expect([...tokens.rows.values()]).toEqual([
      expect.objectContaining({ refreshToken: "refresh-alice" }),
    ]);
  });

  it("invalidates the stored session after a refused refresh", async ({ tokens }) => {
    // GIVEN a refresh token the issuer refuses
    const cookie = await tokens.login();
    tokens.respond({ error: "invalid_grant", error_description: "private-refresh-secret" }, 400);
    await tokens.clock.advance(60_000);
    // WHEN refreshing and then checking the session again
    await tokens.service.accessToken(cookie);
    const session = await tokens.service.session(cookie);
    // THEN the old browser cookie no longer authenticates
    expect(session).toBeOkWith(undefined);
  });

  it("never records provider response details in token observations", async ({ tokens }) => {
    // GIVEN a provider error containing a credential-shaped diagnostic
    const cookie = await tokens.login();
    tokens.respond({ error: "invalid_grant", error_description: "private-refresh-secret" }, 400);
    await tokens.clock.advance(60_000);
    // WHEN the operation is observed
    await tokens.service.accessToken(cookie);
    // THEN credentials stay out of all observer data
    expect(JSON.stringify(tokens.observations)).not.toMatch(
      /private-refresh-secret|refresh-alice|access-alice/,
    );
  });

  it("refuses an expired token without a refresh credential", async ({ tokens }) => {
    // GIVEN a login with no refresh token
    const cookie = await tokens.login("alice", false);
    await tokens.clock.advance(60_000);
    // WHEN resolving an access token
    const token = await tokens.service.accessToken(cookie);
    // THEN it requires a new login
    expect(token).toBeErrTagged("Unauthenticated");
  });

  it("invalidates every use of a replayed cookie after logout", async ({ tokens }) => {
    // GIVEN a live session
    const cookie = await tokens.login();
    // WHEN it is invalidated on a replica
    await tokens.manager().invalidate(cookie).getOrThrow();
    const token = await tokens.service.accessToken(cookie);
    // THEN another replica cannot resolve it
    expect(token).toBeErrTagged("Unauthenticated");
  });

  it("does not resurrect a session when logout races a refresh", async ({ tokens }) => {
    // GIVEN an expired access token
    const cookie = await tokens.login();
    await tokens.clock.advance(60_000);
    // WHEN refresh and logout contend for the same row
    await Promise.all([tokens.service.accessToken(cookie), tokens.manager().invalidate(cookie)]);
    // THEN logout wins after the refresh releases its lock
    expect([...tokens.rows.values()]).toEqual([]);
  });

  it("keeps two sessions isolated", async ({ tokens }) => {
    // GIVEN separate users signed in through the same client
    const alice = await tokens.login("alice");
    const bob = await tokens.login("bob");
    // WHEN alice logs out
    await tokens.service.invalidate(alice).getOrThrow();
    const token = await tokens.service.accessToken(bob);
    // THEN bob retains only bob's token
    expect(token).toBeOkWith("access-bob");
  });

  it.for([undefined, "not-a-session"])(
    "refuses an absent or invalid cookie: %s",
    async (cookie, { tokens }) => {
      // GIVEN a cookie this codec cannot open
      // WHEN resolving its token
      const token = await tokens.service.accessToken(cookie);
      // THEN it is anonymous
      expect(token).toBeErrTagged("Unauthenticated");
    },
  );

  it("does not treat a stateless session as a stored-token session", async ({ tokens }) => {
    // GIVEN a valid cookie with no token reference
    const cookie = await tokens.codec
      .seal({ principal: { userId: "alice" }, iss: "https://issuer.example", clientId: "staff" })
      .get();
    // WHEN resolving its token
    const token = await tokens.service.accessToken(cookie);
    // THEN it is anonymous on this capability
    expect(token).toBeErrTagged("Unauthenticated");
  });

  it("expires server-side credentials without extending them on refresh", async ({ tokens }) => {
    // GIVEN a session past its absolute server lifetime
    const cookie = await tokens.login();
    await tokens.clock.advance(tokens.codec.ttlSec * 1000);
    // WHEN resolving it
    const token = await tokens.service.accessToken(cookie);
    // THEN it requires a new login
    expect(token).toBeErrTagged("Unauthenticated");
  });

  it("does not refresh while merely authenticating a live session", async ({ tokens }) => {
    // GIVEN an expired access token in a still-live browser session
    const cookie = await tokens.login();
    await tokens.clock.advance(60_000);
    // WHEN authentication checks server-side revocation
    await tokens.service.session(cookie).getOrThrow();
    // THEN no token endpoint request is made
    expect(tokens.calls).toEqual([]);
  });
  it("refuses a grant without a bounded bearer lifetime", async ({ tokens }) => {
    // GIVEN a token response with no expiry
    // WHEN retaining it
    const answer = await tokens.service.create(
      { principal: {}, iss: "https://issuer.example", clientId: "staff" },
      "alice",
      { access_token: "access", token_type: "Bearer" },
    );
    // THEN it cannot become an indefinite credential
    expect(answer).toBeErrTagged("Unauthenticated");
  });

  it("refuses a refresh response with an unusable lifetime", async ({ tokens }) => {
    // GIVEN an issuer that returns an already-expired replacement
    const cookie = await tokens.login();
    tokens.respond({ access_token: "expired", token_type: "Bearer", expires_in: 0 });
    await tokens.clock.advance(60_000);
    // WHEN refreshing
    const answer = await tokens.service.accessToken(cookie);
    // THEN the session requires login again
    expect(answer).toBeErrTagged("Unauthenticated");
  });

  it("refuses cleartext issuer configuration outside loopback", async ({ tokens }) => {
    // GIVEN a deployment naming a remote cleartext issuer
    // WHEN building the real provider
    const built = await tokens.provider({
      issuer: "http://issuer.example",
      clientId: "staff",
      clientSecret: "secret",
    });
    // THEN it fails before discovery
    expect(built).toBeErrTagged("ConfigInvalid");
  });

  it("refuses a login bound to a different token manager client", async ({ tokens }) => {
    // GIVEN a token manager for another client
    // WHEN constructing the real login answerer
    const built = await tokens.mismatchedLogin();
    // THEN a browser cannot enter an inconsistent login
    expect(built).toBeErrTagged("ConfigInvalid");
  });
  it("refuses a cookie from another client without deleting that session", async ({ tokens }) => {
    // GIVEN a signed-in user and a manager for a different client
    const cookie = await tokens.login();
    // WHEN the other client attempts to invalidate that cookie
    await tokens.manager("other-client").invalidate(cookie).getOrThrow();
    const answer = await tokens.service.accessToken(cookie);
    // THEN the original session retains its own token
    expect(answer).toBeOkWith("access-alice");
  });

  it("refuses a refreshed id token naming a different subject", async ({ tokens }) => {
    // GIVEN an issuer returning a correctly signed token for another user
    const cookie = await tokens.login();
    const idToken = await tokens.idToken("bob");
    tokens.respond({
      access_token: "other-user",
      token_type: "Bearer",
      expires_in: 120,
      id_token: idToken,
    });
    await tokens.clock.advance(60_000);
    // WHEN refreshing alice's session
    const answer = await tokens.service.accessToken(cookie);
    // THEN bob's credential cannot enter it
    expect(answer).toBeErrTagged("Unauthenticated");
  });

  it("verifies a refreshed id token's signature", async ({ tokens }) => {
    // GIVEN an id token signed by an untrusted key
    const cookie = await tokens.login();
    const idToken = await tokens.idToken("alice", false);
    tokens.respond({
      access_token: "untrusted",
      token_type: "Bearer",
      expires_in: 120,
      id_token: idToken,
    });
    await tokens.clock.advance(60_000);
    // WHEN refreshing
    const answer = await tokens.service.accessToken(cookie);
    // THEN the token endpoint response alone is insufficient
    expect(answer).toBeErrTagged("Unauthenticated");
  });

  it("accepts a correctly signed refresh for the same subject", async ({ tokens }) => {
    // GIVEN a correctly signed id token for the original subject
    const cookie = await tokens.login();
    const idToken = await tokens.idToken("alice");
    tokens.respond({
      access_token: "same-user",
      token_type: "Bearer",
      expires_in: 120,
      id_token: idToken,
    });
    await tokens.clock.advance(60_000);
    // WHEN refreshing
    const answer = await tokens.service.accessToken(cookie);
    // THEN it receives the replacement bearer
    expect(answer).toBeOkWith("same-user");
  });

  it("refuses an expiry whose milliseconds cannot be represented safely", async ({ tokens }) => {
    // GIVEN an implausibly large expiry from a provider
    // WHEN attempting retention
    const answer = await tokens.service.create(
      { principal: {}, iss: "https://issuer.example", clientId: "staff" },
      "alice",
      { access_token: "access", token_type: "Bearer", expires_in: Number.MAX_SAFE_INTEGER },
    );
    // THEN it cannot create an unbounded credential
    expect(answer).toBeErrTagged("Unauthenticated");
  });
});
