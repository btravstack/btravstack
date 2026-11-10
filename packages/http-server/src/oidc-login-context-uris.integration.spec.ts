import { describe, expect } from "vitest";

import { it } from "./__tests__/oidc-login-context.fixture.js";

describe("redirect URIs derived from the OIDC login context", () => {
  const hosts = {
    redirectUri: (tenant: string) => `https://${tenant}.app.example/auth/callback`,
    postLogoutRedirectUri: (tenant: string) => `https://${tenant}.app.example/signed-out`,
  };

  it("sends each context's own redirect URI to authorization and the code exchange", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin(hosts);
    // WHEN
    const alpha = await browser.login("alpha");
    const beta = await browser.login("beta");
    // THEN
    expect({ statuses: [alpha.status, beta.status], exchanges: browser.exchanges() }).toEqual({
      statuses: [303, 303],
      exchanges: [
        {
          authorize: "https://alpha.app.example/auth/callback",
          token: "https://alpha.app.example/auth/callback",
        },
        {
          authorize: "https://beta.app.example/auth/callback",
          token: "https://beta.app.example/auth/callback",
        },
      ],
    });
  });

  it("refuses a callback delivered to another context's redirect URI before replacing the retained login", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin(hosts);
    await browser.login("beta");
    const sessionCookie = browser.cookies.get("__Host-session");
    const before = [...browser.changes];
    const begun = await browser.begin("alpha");
    const callback = new URL(await browser.authorize(begun.location, "alpha"));
    callback.host = "beta.app.example";
    // WHEN
    const result = await browser.go(callback.href);
    const session = await browser.go("/session");
    // THEN
    expect({
      status: result.status,
      cookieUnchanged: browser.cookies.get("__Host-session") === sessionCookie,
      session: JSON.parse(session.body),
      mutations: browser.changes.slice(before.length),
      records: browser.rows.size,
      exchanged: browser.exchanges().length,
    }).toEqual({
      status: 400,
      cookieUnchanged: true,
      session: { subject: "beta-account", tenant: "beta" },
      mutations: [],
      records: 1,
      exchanged: 1,
    });
  });

  it.for([
    ["alpha.app.example", "beta.app.example", 303],
    ["beta.app.example", "alpha.app.example", 400],
  ] as const)(
    "reads the callback's host from an absolute-form target before Host: %s under Host %s",
    async ([target, host, status], { contextLogin }) => {
      // GIVEN
      const browser = await contextLogin(hosts);
      const begun = await browser.begin("alpha");
      const callback = new URL(await browser.authorize(begun.location, "alpha"));
      callback.host = target;
      // WHEN
      const result = await browser.go(callback.href, "GET", host);
      // THEN
      expect(result.status).toBe(status);
    },
  );

  it.for([
    "/auth/callback",
    "ftp://alpha.app.example/auth/callback",
    "https://name:secret@alpha.app.example/auth/callback",
    "https://alpha.app.example/auth/callback#fragment",
    "https://alpha.app.example/elsewhere/callback",
  ])(
    "refuses the login before redirecting when the derived redirect URI is invalid: %s",
    async (uri, { contextLogin }) => {
      // GIVEN
      const browser = await contextLogin({ redirectUri: () => uri });
      // WHEN
      const result = await browser.begin();
      // THEN
      expect({
        status: result.status,
        location: result.location,
        changes: browser.changes,
      }).toEqual({ status: 400, location: null, changes: [] });
    },
  );

  it("refuses the login before redirecting when the derived post-logout URI is invalid", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin({ ...hosts, postLogoutRedirectUri: () => "/signed-out" });
    // WHEN
    const result = await browser.begin();
    // THEN
    expect({ status: result.status, location: result.location }).toEqual({
      status: 400,
      location: null,
    });
  });

  it("logs out to the post-logout URI the session was admitted with, whatever host asks", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin(hosts);
    await browser.login("beta");
    // WHEN
    const result = await browser.go("https://alpha.app.example/auth/logout", "POST");
    const destination = new URL(result.location ?? "https://invalid.example");
    // THEN
    expect({
      status: result.status,
      endpoint: destination.pathname,
      returnUri: destination.searchParams.get("post_logout_redirect_uri"),
      hinted: destination.searchParams.has("id_token_hint"),
      records: browser.rows.size,
    }).toEqual({
      status: 303,
      endpoint: "/logout",
      returnUri: "https://beta.app.example/signed-out",
      hinted: true,
      records: 0,
    });
  });

  it("keeps the static redirect URI and a parameterless logout when the context derives none", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    await browser.login("alpha");
    // WHEN
    const result = await browser.logout();
    // THEN
    expect({
      exchanges: browser.exchanges(),
      logout: new URL(result.location ?? "https://invalid.example").searchParams.toString(),
    }).toEqual({
      exchanges: [
        {
          authorize: "https://app.example/auth/callback",
          token: "https://app.example/auth/callback",
        },
      ],
      logout: expect.stringMatching(/^client_id=context-/),
    });
  });
});
