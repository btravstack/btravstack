import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/oidc-login-context.fixture.js";

describe("application context bound to the OIDC login transaction", () => {
  it.for([false, true])(
    "falls back to root when the complete transient cookie exceeds the browser limit: %s",
    async (withoutContext, { contextLogin }) => {
      // GIVEN
      const tenant = "a".repeat(1000);
      const browser = await contextLogin({ withoutContext, resolvedTenant: tenant });
      const destination = `/${"x".repeat(5000)}`;
      // WHEN
      const begun = await browser.go(
        `/auth/login?tenant=${tenant}&return=${encodeURIComponent(destination)}`,
      );
      const result = await browser.go(await browser.authorize(begun.location, tenant));
      // THEN
      expect({
        status: result.status,
        destination: result.location,
        fits: begun.cookies.every((cookie) => Buffer.byteLength(cookie) <= 4096),
        admitted: browser.admitted,
      }).toEqual({
        status: 303,
        destination: "/",
        fits: true,
        admitted: withoutContext ? [] : [{ tenant }],
      });
    },
  );

  it("refuses an oversized protected binding before redirecting to the provider", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin({ clientId: "client-" + "x".repeat(3000) });
    // WHEN
    const result = await browser.begin();
    // THEN
    expect({
      status: result.status,
      location: result.location,
      cookies: result.cookies,
      changes: browser.changes,
    }).toEqual({
      status: 400,
      location: null,
      cookies: ["__Host-oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"],
      changes: [],
    });
  });

  it("waits for asynchronous application context resolution", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin({ asyncResolve: true });
    // WHEN
    const result = await browser.login();
    // THEN
    expect({ status: result.status, admitted: browser.admitted }).toEqual({
      status: 303,
      admitted: [{ tenant: "alpha" }],
    });
  });

  it("refuses a modeled application context refusal", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin({ refuseResolve: true });
    // WHEN
    const result = await browser.begin();
    // THEN
    expect({ status: result.status, location: result.location, changes: browser.changes }).toEqual({
      status: 400,
      location: null,
      changes: [],
    });
  });

  it("does not forward an unvalidated legacy login hint into a context-bound login", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    // WHEN
    const result = await browser.go("/auth/login?tenant=alpha&as=foreign-account");
    const parameters = new URL(result.location ?? "https://invalid.example").searchParams;
    // THEN
    expect({
      status: result.status,
      hint: parameters.get("login_hint"),
      connection: parameters.get("connection"),
    }).toEqual({ status: 303, hint: null, connection: "alpha-idp" });
  });

  it("rejects an ID token signed by an unpublished key before principal admission", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    const begun = await browser.begin();
    const callback = await browser.authorize(begun.location, "alpha", false);
    // WHEN
    const result = await browser.go(callback);
    // THEN
    expect({ status: result.status, admitted: browser.admitted, changes: browser.changes }).toEqual(
      { status: 401, admitted: [], changes: [] },
    );
  });
  it("resolves context with injected application services and admits the matching account", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    // WHEN
    const result = await browser.login("beta");
    const session = await browser.go("/session");
    // THEN
    expect({
      status: result.status,
      session: JSON.parse(session.body),
      resolved: browser.resolved,
    }).toEqual({
      status: 303,
      session: { subject: "beta-account", tenant: "beta" },
      resolved: ["GET"],
    });
  });

  it("derives allowlisted provider parameters from the validated context", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    // WHEN
    const result = await browser.begin("beta");
    const parameters = new URL(result.location ?? "https://invalid.example").searchParams;
    // THEN
    expect({
      status: result.status,
      connection: parameters.get("connection"),
      prompt: parameters.get("prompt"),
      pkce: parameters.get("code_challenge_method"),
    }).toEqual({
      status: 303,
      connection: "beta-idp",
      prompt: "login",
      pkce: "S256",
    });
  });

  it("keeps context protected inside the transaction instead of adding it to authorization parameters", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    // WHEN
    const result = await browser.begin();
    const parameters = new URL(result.location ?? "https://invalid.example").searchParams;
    const held = await browser.transient();
    // THEN
    expect({
      queryContext: parameters.get("context"),
      context: JSON.parse(held["context"] ?? "null"),
      cookieContainsContext: result.cookies.join().includes('"tenant"'),
    }).toEqual({
      queryContext: null,
      context: { tenant: "alpha" },
      cookieContainsContext: false,
    });
  });

  it("preserves existing logins when no application context extension is composed", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin({ withoutContext: true });
    // WHEN
    const result = await browser.login();
    const session = await browser.go("/session");
    // THEN
    expect({ status: result.status, session: JSON.parse(session.body) }).toEqual({
      status: 303,
      session: { subject: "alpha-account" },
    });
  });

  it.for(["", "foreign"])(
    "refuses a missing or unauthorized login context: %s",
    async (tenant, { contextLogin }) => {
      // GIVEN
      const browser = await contextLogin();
      // WHEN
      const result = await browser.begin(tenant);
      // THEN
      expect({
        status: result.status,
        location: result.location,
        changes: browser.changes,
      }).toEqual({ status: 400, location: null, changes: [] });
    },
  );

  it.for(["", "x".repeat(1500)])(
    "refuses schema-invalid or oversized resolved context",
    async (resolvedTenant, { contextLogin }) => {
      // GIVEN
      const browser = await contextLogin({ resolvedTenant });
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

  it.for([
    "state",
    "nonce",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "response_type",
    "scope",
  ])(
    "refuses protocol parameter overrides even if allowlisted: %s",
    async (name, { contextLogin }) => {
      // GIVEN
      const browser = await contextLogin({
        parameters: { [name]: "attacker" },
        allowedParameters: [name],
      });
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

  it("refuses provider parameters outside the deployment allowlist", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin({ parameters: { unapproved_connection: "foreign" } });
    // WHEN
    const result = await browser.begin();
    // THEN
    expect({ status: result.status, location: result.location }).toEqual({
      status: 400,
      location: null,
    });
  });

  it("refuses a valid account from the wrong organization without replacing the retained login", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    await browser.login("alpha");
    const sessionCookie = browser.cookies.get("__Host-session");
    const before = [...browser.changes];
    // WHEN
    const result = await browser.login("beta", "alpha");
    const session = await browser.go("/session");
    // THEN
    expect({
      status: result.status,
      cookieUnchanged: browser.cookies.get("__Host-session") === sessionCookie,
      session: JSON.parse(session.body),
      mutations: browser.changes.slice(before.length),
      records: browser.rows.size,
    }).toEqual({
      status: 400,
      cookieUnchanged: true,
      session: { subject: "alpha-account", tenant: "alpha" },
      mutations: [],
      records: 1,
    });
  });

  it("refuses principal admission before storing new credentials", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin({ rejectPrincipal: true });
    // WHEN
    const result = await browser.login();
    // THEN
    expect({
      status: result.status,
      changes: browser.changes,
      records: browser.rows.size,
      sessionCookie: browser.cookies.get("__Host-session"),
    }).toEqual({ status: 400, changes: [], records: 0, sessionCookie: undefined });
  });

  it("keeps separately held simultaneous login contexts associated with their own callbacks", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    const first = await browser.begin("alpha");
    const firstCookie = browser.cookies.get("__Host-oidc") ?? "";
    const second = await browser.begin("beta");
    const secondCookie = browser.cookies.get("__Host-oidc") ?? "";
    const firstCallback = await browser.authorize(first.location, "alpha");
    const secondCallback = await browser.authorize(second.location, "beta");
    // WHEN
    browser.cookies.set("__Host-oidc", firstCookie);
    const firstResult = await browser.go(firstCallback);
    browser.cookies.set("__Host-oidc", secondCookie);
    const secondResult = await browser.go(secondCallback);
    // THEN
    expect({
      statuses: [firstResult.status, secondResult.status],
      admitted: browser.admitted,
    }).toEqual({ statuses: [303, 303], admitted: [{ tenant: "alpha" }, { tenant: "beta" }] });
  });

  it("refuses an earlier callback when another tab has replaced the transaction cookie", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    const first = await browser.begin("alpha");
    const callback = await browser.authorize(first.location, "alpha");
    await browser.begin("beta");
    // WHEN
    const result = await browser.go(callback);
    // THEN
    expect({ status: result.status, admitted: browser.admitted, changes: browser.changes }).toEqual(
      { status: 400, admitted: [], changes: [] },
    );
  });

  it.for([undefined, "{", "null", '{"tenant":""}'])(
    "refuses missing or malformed protected context before principal admission: %s",
    async (context, { contextLogin }) => {
      // GIVEN
      const browser = await contextLogin();
      const first = await browser.begin();
      const callback = await browser.authorize(first.location);
      const held = { ...(await browser.transient()) };
      delete held["context"];
      if (context !== undefined) held["context"] = context;
      await browser.replaceTransient(held);
      // WHEN
      const result = await browser.go(callback);
      // THEN
      expect({
        status: result.status,
        admitted: browser.admitted,
        changes: browser.changes,
      }).toEqual({ status: 400, admitted: [], changes: [] });
    },
  );

  it("refuses a transaction sealed for another application binding", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin();
    const first = await browser.begin();
    const callback = await browser.authorize(first.location);
    await browser.replaceTransient({ ...(await browser.transient()), binding: "foreign-client" });
    // WHEN
    const result = await browser.go(callback);
    // THEN
    expect({ status: result.status, admitted: browser.admitted, changes: browser.changes }).toEqual(
      { status: 400, admitted: [], changes: [] },
    );
  });

  it("refuses tampered transaction ciphertext", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin();
    const first = await browser.begin();
    const callback = await browser.authorize(first.location);
    const pieces = (browser.cookies.get("__Host-oidc") ?? "").split(".");
    pieces[3] = `${pieces[3]?.startsWith("A") ? "B" : "A"}${pieces[3]?.slice(1)}`;
    browser.cookies.set("__Host-oidc", pieces.join("."));
    // WHEN
    const result = await browser.go(callback);
    // THEN
    expect({ status: result.status, admitted: browser.admitted, changes: browser.changes }).toEqual(
      { status: 400, admitted: [], changes: [] },
    );
  });

  it("refuses an expired login transaction", async ({ contextLogin }) => {
    // GIVEN
    const browser = await contextLogin();
    const first = await browser.begin();
    const callback = await browser.authorize(first.location);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 301_000);
    // WHEN
    const result = await browser.go(callback);
    // THEN
    expect({ status: result.status, admitted: browser.admitted, changes: browser.changes }).toEqual(
      { status: 400, admitted: [], changes: [] },
    );
  });

  it("preserves the existing session when the provider refuses authentication", async ({
    contextLogin,
  }) => {
    // GIVEN
    const browser = await contextLogin();
    await browser.login();
    await browser.begin("beta");
    const held = await browser.transient();
    const before = [...browser.changes];
    const callback = new URLSearchParams({ state: held["state"] ?? "", error: "access_denied" });
    // WHEN
    const result = await browser.go(`/auth/callback?${callback.toString()}`);
    const session = await browser.go("/session");
    // THEN
    expect({
      status: result.status,
      session: JSON.parse(session.body),
      mutations: browser.changes.slice(before.length),
    }).toEqual({
      status: 401,
      session: { subject: "alpha-account", tenant: "alpha" },
      mutations: [],
    });
  });
});
