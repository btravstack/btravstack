import { ORY_USERS } from "@btravstack/internal-test-infra/ory";
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
    const browser = await bff(undefined, tokens.store);
    await browser.login(ORY_USERS.alice);
    const cookie = browser.held(SESSION_COOKIE) ?? "";
    // WHEN logout clears the server state and the old cookie is replayed
    await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    browser.plant(SESSION_COOKIE, cookie);
    const page = await browser.go("/orders/1/row");
    // THEN it must log in again
    expect({ page: page.status, records: tokens.rows.size }).toEqual({ page: 303, records: 0 });
  }, 180_000);

  it("keeps access and refresh tokens out of cookies, HTML and observations", async ({
    bff,
    tokens,
  }) => {
    // GIVEN a retained token response
    const browser = await bff(undefined, tokens.store);
    const callback = await browser.login(ORY_USERS.alice);
    const record = [...tokens.rows.values()][0];
    // WHEN reading everything the browser or observers received
    const page = await browser.go("/orders/1/row");
    const publicData = JSON.stringify({ callback, page, observations: browser.observations() });
    // THEN neither credential is present
    expect(
      [record?.accessToken, record?.refreshToken]
        .filter((token) => token !== undefined)
        .map((token) => publicData.includes(token)),
    ).toEqual([false, false]);
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
    const browser = await bff(undefined, tokens.store);
    await browser.login(ORY_USERS.alice);
    tokens.failStore();
    // WHEN logout cannot delete credentials
    const callback = await browser.go("/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    // THEN it reports the unavailable dependency
    expect(callback.status).toEqual(503);
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
