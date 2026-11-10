import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("oidc logout context", () => {
  it("returns the stored hint while deleting its credentials", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({
      context: expect.toBeOkWith({ idToken: "original-id-token" }),
      records: 0,
    });
  });

  it("does not return a hint for a replayed cookie", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    await tokens.service.logout(cookie).getOrThrow();
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect(context).toBeOkWith(undefined);
  });

  it("invalidates legacy retained credentials without an id token", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login();
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({
      context: expect.toBeOkWith(undefined),
      records: 0,
    });
  });

  it.for([undefined, "invalid-cookie"])(
    "keeps an unopenable cookie anonymous: %s",
    async (cookie, { tokens }) => {
      // GIVEN
      // WHEN
      const context = await tokens.service.logout(cookie);
      // THEN
      expect(context).toBeOkWith(undefined);
    },
  );

  it("does not return a hint for an expired retained session", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "expired-id-token");
    await tokens.clock.advance(tokens.codec.ttlSec * 1000);
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({
      context: expect.toBeOkWith(undefined),
      records: 0,
    });
  });

  it("refuses another client's cookie without touching its credentials", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "other-client-id-token");
    // WHEN
    const context = await tokens.manager("customers").logout(cookie);
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({
      context: expect.toBeOkWith(undefined),
      records: 1,
    });
  });

  it("refuses another issuer's cookie without touching its credentials", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "other-issuer-id-token");
    // WHEN
    const context = await tokens.manager("staff", "https://other.example").logout(cookie);
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({
      context: expect.toBeOkWith(undefined),
      records: 1,
    });
  });

  it("does not expose a foreign record through a cookie naming this login", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "foreign-id-token");
    for (const [reference, record] of tokens.rows)
      tokens.rows.set(reference, { ...record, clientId: "customers" });
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({
      context: expect.toBeOkWith(undefined),
      records: 1,
    });
  });

  it("preserves the original hint when refresh omits a replacement", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    await tokens.clock.advance(60_000);
    await tokens.service.accessToken(cookie).getOrThrow();
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect(context).toBeOkWith({ idToken: "original-id-token" });
  });

  it("uses a replacement hint only after validating the refresh", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    const idToken = await tokens.idToken("alice");
    tokens.respond({
      access_token: "replacement-access",
      token_type: "Bearer",
      expires_in: 120,
      id_token: idToken,
    });
    await tokens.clock.advance(60_000);
    await tokens.service.accessToken(cookie).getOrThrow();
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect(context).toBeOkWith({ idToken });
  });

  it("never returns the hint from a refused refreshed subject", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    const idToken = await tokens.idToken("bob");
    tokens.respond({
      access_token: "foreign-access",
      token_type: "Bearer",
      expires_in: 120,
      id_token: idToken,
    });
    await tokens.clock.advance(60_000);
    await tokens.service.accessToken(cookie);
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect(context).toBeOkWith(undefined);
  });

  it("waits for an in-flight refresh then revokes its replacement", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    const idToken = await tokens.idToken("alice");
    tokens.respond({
      access_token: "replacement-access",
      token_type: "Bearer",
      expires_in: 120,
      id_token: idToken,
    });
    await tokens.clock.advance(60_000);
    const gate = tokens.pauseRefresh();
    const refresh = tokens.service.accessToken(cookie).getOrThrow();
    await gate.entered;
    // WHEN
    const logout = tokens.manager().logout(cookie).getOrThrow();
    gate.release();
    await refresh;
    const context = await logout;
    // THEN
    expect({ context, records: tokens.rows.size }).toEqual({ context: { idToken }, records: 0 });
  });

  it("does not refresh a session that logout already revoked", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "original-id-token");
    await tokens.clock.advance(60_000);
    await tokens.manager().logout(cookie).getOrThrow();
    // WHEN
    const access = await tokens.service.accessToken(cookie);
    // THEN
    expect({ access, requests: tokens.calls }).toEqual({
      access: expect.toBeErrTagged("Unauthenticated"),
      requests: [],
    });
  });

  it("keeps the logout hint out of observations and the cookie", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "private-id-token");
    const session = await tokens.codec.unseal(cookie).get();
    // WHEN
    await tokens.service.logout(cookie).getOrThrow();
    // THEN
    expect(JSON.stringify({ session, observations: tokens.observations })).not.toMatch(
      /private-id-token|access-alice|refresh-alice/,
    );
  });

  it("reports storage failure rather than returning a reusable hint", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login("alice", true, "private-id-token");
    tokens.failStore();
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect(context).toBeErrTagged("OidcTokenStoreUnavailable");
  });

  it("returns the derived return with the hint, across a refresh", async ({ tokens }) => {
    // GIVEN
    const cookie = await tokens.login(
      "alice",
      true,
      "original-id-token",
      "https://acme.app.example/signed-out",
    );
    await tokens.clock.advance(60_000);
    await tokens.service.accessToken(cookie).getOrThrow();
    // WHEN
    const context = await tokens.service.logout(cookie);
    // THEN
    expect(context).toBeOkWith({
      idToken: "original-id-token",
      postLogoutRedirectUri: "https://acme.app.example/signed-out",
    });
  });
});
