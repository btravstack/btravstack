import {
  ORY_CLIENT_ID,
  ORY_ISSUER,
  ORY_POST_LOGOUT_URI,
  ORY_USERS,
} from "@btravstack/internal-test-infra/ory";
import { followRedirects } from "@btravstack/internal-test-infra/ory-login";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { SESSION_COOKIE } from "./session.js";

describe("oidc token retention over the real login flow", () => {
  it("retains the token response without rendering credentials", async ({ bff, tokens }) => {
    // GIVEN the existing login answerer with a shared token store
    const browser = await bff(undefined, tokens.store);
    // WHEN a browser completes the real Ory code flow
    const callback = await browser.login(ORY_USERS.alice, "?return=/orders/1/row");
    const page = await browser.go("/orders/1/row");
    // THEN login still serves the existing protected fragment
    expect({ callback: callback.status, page: page.status, records: tokens.rows.size }).toEqual({
      callback: 303,
      page: 200,
      records: 1,
    });
  }, 180_000);

  it("deletes server credentials on logout and refuses a replayed cookie", async ({
    bff,
    tokens,
  }) => {
    // GIVEN a browser that has completed the code flow
    const browser = await bff(undefined, tokens.store, {
      postLogoutRedirectUri: ORY_POST_LOGOUT_URI,
    });
    await browser.login(ORY_USERS.alice);
    const cookie = browser.held(SESSION_COOKIE) ?? "";
    // WHEN logout clears the server state and the old cookie is replayed
    const loggedOut = await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    const cleared = browser.held(SESSION_COOKIE);
    browser.plant(SESSION_COOKIE, cookie);
    const page = await browser.go("/orders/1/row");
    // THEN it must log in again
    expect({
      logout: loggedOut.status,
      cleared,
      page: page.status,
      records: tokens.rows.size,
    }).toEqual({ logout: 303, cleared: undefined, page: 303, records: 0 });
  }, 180_000);

  it("returns through the real provider to the registered uri with the retained hint", async ({
    bff,
    tokens,
  }) => {
    // GIVEN a real provider session and a deployment-registered return URI
    const browser = await bff(undefined, tokens.store, {
      postLogoutRedirectUri: ORY_POST_LOGOUT_URI,
    });
    await browser.login(ORY_USERS.alice);
    const record = [...tokens.rows.values()][0];
    // WHEN logout is requested with attacker-controlled alternative destinations
    const loggedOut = await browser.go(
      "/auth/logout?post_logout_redirect_uri=https://attacker.example&return=https://attacker.example",
      { method: "POST", headers: { "sec-fetch-site": "same-origin", host: "attacker.example" } },
    );
    const destination = new URL(loggedOut.location ?? "");
    const landed = await followRedirects(destination, ORY_POST_LOGOUT_URI);
    // THEN the provider accepts the server-held hint and the configured return only
    expect({
      status: loggedOut.status,
      hint: destination.searchParams.get("id_token_hint"),
      retainedHint: record?.idToken,
      returnUri: destination.searchParams.get("post_logout_redirect_uri"),
      landed: landed.href,
      leakedTokens: [record?.accessToken, record?.refreshToken].map((token) =>
        token === undefined ? true : loggedOut.location?.includes(token),
      ),
    }).toEqual({
      status: 303,
      hint: record?.idToken,
      retainedHint: expect.any(String),
      returnUri: ORY_POST_LOGOUT_URI,
      landed: ORY_POST_LOGOUT_URI,
      leakedTokens: [false, false],
    });
  }, 180_000);

  it("requires a hint for the real provider's registered return", async ({ ory: _ory }) => {
    // GIVEN a return URI registered on the real provider's client
    const destination = new URL("oauth2/sessions/logout", ORY_ISSUER);
    destination.searchParams.set("client_id", ORY_CLIENT_ID);
    destination.searchParams.set("post_logout_redirect_uri", ORY_POST_LOGOUT_URI);
    // WHEN the return is requested without its ID-token hint
    const refused = await fetch(destination, { redirect: "manual" });
    const error = new URL(refused.headers.get("location") ?? "");
    // THEN the provider does not silently substitute its same-valued default return
    expect({
      status: refused.status,
      endpoint: `${error.origin}${error.pathname}`,
      error: error.searchParams.get("error"),
      reason: error.searchParams.get("error_description"),
    }).toEqual({
      status: 302,
      endpoint: `${ORY_ISSUER}oauth2/fallbacks/error`,
      error: "invalid_request",
      reason: expect.stringContaining(
        "post_logout_redirect_uri is set but id_token_hint is missing",
      ),
    });
  }, 180_000);

  it("keeps a retained login's logout parameterless when no return uri is configured", async ({
    bff,
    tokens,
  }) => {
    // GIVEN a retained login with the existing logout configuration
    const browser = await bff(undefined, tokens.store);
    await browser.login(ORY_USERS.alice);
    // WHEN the browser logs out
    const loggedOut = await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    // THEN retaining the ID token does not change the existing redirect
    expect(loggedOut.location).toEqual(
      `${ORY_ISSUER}oauth2/sessions/logout?client_id=${ORY_CLIENT_ID}`,
    );
  }, 180_000);

  it("cannot recover a logout hint by replaying a revoked session", async ({ bff, tokens }) => {
    // GIVEN a session whose server credentials were already revoked
    const browser = await bff(undefined, tokens.store, {
      postLogoutRedirectUri: ORY_POST_LOGOUT_URI,
    });
    await browser.login(ORY_USERS.alice);
    const cookie = browser.held(SESSION_COOKIE) ?? "";
    await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    browser.plant(SESSION_COOKIE, cookie);
    // WHEN the old encrypted session is replayed at logout
    const replayed = await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    // THEN there is no hint left to disclose or registered return to request
    expect({ location: replayed.location, records: tokens.rows.size }).toEqual({
      location: `${ORY_ISSUER}oauth2/sessions/logout?client_id=${ORY_CLIENT_ID}`,
      records: 0,
    });
  }, 180_000);

  it("keeps every retained token out of cookies, HTML and observations", async ({
    bff,
    tokens,
  }) => {
    // GIVEN a retained token response
    const browser = await bff(undefined, tokens.store, {
      postLogoutRedirectUri: ORY_POST_LOGOUT_URI,
    });
    const callback = await browser.login(ORY_USERS.alice);
    const record = [...tokens.rows.values()][0];
    // WHEN reading everything the browser or observers received
    const page = await browser.go("/orders/1/row");
    await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    const publicData = JSON.stringify({ callback, page, observations: browser.observations() });
    // THEN no retained credential is present
    expect(
      [record?.accessToken, record?.refreshToken, record?.idToken].map((token) =>
        token === undefined ? true : publicData.includes(token),
      ),
    ).toEqual([false, false, false]);
  }, 180_000);
  it("refuses login when shared storage cannot retain its credentials", async ({ bff, tokens }) => {
    // GIVEN a reachable identity provider but unavailable session storage
    const browser = await bff(undefined, tokens.store);
    tokens.failStore();
    // WHEN completing a real login
    const callback = await browser.login(ORY_USERS.alice);
    // THEN it reports failure and emits no session cookie
    expect({ status: callback.status, session: browser.held(SESSION_COOKIE) }).toEqual({
      status: 503,
      session: undefined,
    });
  }, 180_000);

  it("does not report successful logout while credential deletion is unavailable", async ({
    bff,
    tokens,
  }) => {
    // GIVEN a live retained session and a subsequent storage outage
    const browser = await bff(undefined, tokens.store, {
      postLogoutRedirectUri: ORY_POST_LOGOUT_URI,
    });
    await browser.login(ORY_USERS.alice);
    tokens.failStore();
    // WHEN logout cannot delete credentials
    const callback = await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    // THEN it reports the unavailable dependency
    expect({
      status: callback.status,
      location: callback.location,
      cookie: browser.held(SESSION_COOKIE),
      records: tokens.rows.size,
    }).toEqual({ status: 503, location: null, cookie: undefined, records: 1 });
  }, 180_000);

  it("fails authentication closed while shared storage is unavailable", async ({ bff, tokens }) => {
    // GIVEN a live retained session and a subsequent storage outage
    const browser = await bff(undefined, tokens.store);
    await browser.login(ORY_USERS.alice);
    tokens.failStore();
    // WHEN a protected fragment is requested
    const page = await browser.go("/orders/1/row");
    // THEN the encrypted cookie alone is insufficient
    expect(page.status).toEqual(303);
  }, 180_000);
  it("refuses a referenced cookie on an authenticator without token retention", async ({
    bff,
    tokens,
  }) => {
    // GIVEN two deployments sharing cookie keys, one with token retention
    const retained = await bff(undefined, tokens.store);
    const stateless = await bff();
    await retained.login(ORY_USERS.alice);
    stateless.plant(SESSION_COOKIE, retained.held(SESSION_COOKIE) ?? "");
    // WHEN the stateless scheme receives the retained session
    const page = await stateless.go("/orders/1/row");
    // THEN it cannot bypass the server-side revocation check
    expect(page.status).toEqual(303);
  }, 180_000);
});
