import {
  ORY_CLIENT_ID,
  ORY_CLIENT_SECRET,
  ORY_ISSUER,
  ORY_REDIRECT_URI,
  ORY_USERS,
} from "@btravstack/internal-test-infra/ory";
import { describe, expect } from "vitest";

import { oidcEnv, it, sessionKeys } from "./__tests__/test-fixtures.js";
import { OidcUnreachable } from "./oidc.js";

/**
 * The whole walk runs against the shared Ory containers, and a cold machine
 * starts three of them plus a network before the first test can begin.
 */
const START_UP = 180_000;

/** A `Location` that is absent fails the assertion below rather than the parse. */
const ABSENT = "http://absent.invalid/";

/** What the callback writes on EVERY exit: the flow state is spent either way. */
const CLEARED = "__Host-oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

describe("oidc(), the login answerer", () => {
  it(
    "starts the code flow: a 303 to the provider carrying PKCE, state and nonce, and seals them into the transient cookie",
    async ({ bff }) => {
      // GIVEN a deployment composing `oidc()` over the shared provider
      const browser = await bff();

      // WHEN a browser is sent to the login route
      const started = await browser.go("/auth/login");
      const authorize = new URL(started.location ?? ABSENT);

      // THEN it is redirected to the provider with a PKCE challenge, a state
      // and a nonce, against the REGISTERED redirect URI — and the flow's own
      // state rides back on a five-minute cookie of its own
      expect({
        status: started.status,
        method: authorize.searchParams.get("code_challenge_method"),
        challenged: authorize.searchParams.get("code_challenge") !== null,
        stated: authorize.searchParams.get("state") !== null,
        nonced: authorize.searchParams.get("nonce") !== null,
        clientId: authorize.searchParams.get("client_id"),
        redirectUri: authorize.searchParams.get("redirect_uri"),
        transient: started.setCookie,
      }).toEqual({
        status: 303,
        method: "S256",
        challenged: true,
        stated: true,
        nonced: true,
        clientId: ORY_CLIENT_ID,
        redirectUri: ORY_REDIRECT_URI,
        transient: [
          expect.stringMatching(
            /^__Host-oidc=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300$/,
          ),
        ],
      });
    },
    START_UP,
  );

  it(
    "logs a browser in end to end and serves the fragment it was going to",
    async ({ bff }) => {
      // GIVEN a browser sent to log in on its way to a fragment behind the
      // session scheme
      const browser = await bff();

      // WHEN the whole authorization-code flow is walked — out to Ory, signed
      // in as alice, and back to this deployment's own callback
      const back = await browser.login(ORY_USERS.alice, "?return=/orders/1/row");
      const fragment = await browser.go("/orders/1/row");

      // THEN the callback seals a session and clears the transient, sends the
      // browser where it was going, and that fragment answers with alice's own
      // tenant — behind a scope only the ID token's `scope` claim carries
      expect({
        callback: { status: back.status, location: back.location },
        cookies: back.setCookie,
        fragment: { status: fragment.status, text: fragment.text },
      }).toEqual({
        callback: { status: 303, location: "/orders/1/row" },
        cookies: [
          expect.stringMatching(
            /^__Host-session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$/,
          ),
          CLEARED,
        ],
        fragment: { status: 200, text: `<p>1 ${ORY_USERS.alice.tenant}</p>` },
      });
    },
    START_UP,
  );

  it(
    "refuses a callback whose state does not match its cookie, with 400 and no session",
    async ({ bff }) => {
      // GIVEN a genuine authorization response, and a `state` somebody changed
      const browser = await bff();
      const started = await browser.go("/auth/login");
      const back = await browser.authorize(started.location, ORY_USERS.alice);
      back.searchParams.set("state", "not-the-one-that-was-sealed");

      // WHEN it is presented to the callback
      const refused = await browser.go(`/auth/callback${back.search}`);
      const fragment = await browser.go("/orders/1/row");

      // THEN nothing is exchanged, no session is set, the spent transient is
      // cleared, the reason is written down once, and the caller is still
      // anonymous — the fragment sends them back to log in
      expect({
        status: refused.status,
        cookies: refused.setCookie,
        observed: browser
          .observations()
          .find((seen) => seen.component === "oidc" && seen.name === "callback"),
        fragment: fragment.status,
      }).toEqual({
        status: 400,
        cookies: [CLEARED],
        observed: {
          component: "oidc",
          name: "callback",
          attributes: { reason: "state_mismatch" },
          outcome: "error",
        },
        fragment: 303,
      });
    },
    START_UP,
  );

  it(
    "refuses a callback carrying no transient cookie at all",
    async ({ bff }) => {
      // GIVEN a genuine authorization response and a browser that no longer
      // holds the flow state it was minted for
      const browser = await bff();
      const started = await browser.go("/auth/login");
      const back = await browser.authorize(started.location, ORY_USERS.alice);
      browser.forget();

      // WHEN the callback is replayed from there
      const refused = await browser.go(`/auth/callback${back.search}`);

      // THEN it is the same refusal, told apart in the log rather than on the
      // wire: a callback with nothing to check against is somebody else's flow
      expect({
        status: refused.status,
        cookies: refused.setCookie,
        observed: browser
          .observations()
          .find((seen) => seen.component === "oidc" && seen.name === "callback"),
      }).toEqual({
        status: 400,
        cookies: [CLEARED],
        observed: {
          component: "oidc",
          name: "callback",
          attributes: { reason: "transient_missing" },
          outcome: "error",
        },
      });
    },
    START_UP,
  );

  it(
    "refuses a code the provider rejects, with 401 and no session",
    async ({ bff }) => {
      // GIVEN a callback whose `state` is the sealed one and whose code is not
      const browser = await bff();
      const started = await browser.go("/auth/login");
      const back = await browser.authorize(started.location, ORY_USERS.alice);
      back.searchParams.set("code", "not-a-code-this-provider-issued");

      // WHEN the grant is attempted
      const refused = await browser.go(`/auth/callback${back.search}`);

      // THEN the exchange failing is a 401 rather than a 400: the flow state
      // was ours, and it is the credential the provider would not take — and
      // the library's own error NAME is on the line, which is the difference
      // between "bad logins" and "the client secret was rotated"
      expect({
        status: refused.status,
        cookies: refused.setCookie,
        observed: browser
          .observations()
          .find((seen) => seen.component === "oidc" && seen.name === "callback"),
      }).toEqual({
        status: 401,
        cookies: [CLEARED],
        observed: {
          component: "oidc",
          name: "callback",
          attributes: { reason: "grant_failed" },
          outcome: "error",
          // The library's own error, on the unbounded channel: this is the
          // difference between "bad logins" and "the client secret rotated".
          cause: expect.any(Error),
        },
      });
    },
    START_UP,
  );

  it(
    "refuses a callback whose transient names a nonce the ID token does not carry",
    async ({ bff, sessionCodecOf }) => {
      // GIVEN a genuine authorization response, and the flow state re-sealed
      // with a nonce that is not the one the authorization request asked for —
      // the codec's own keys, so it is a transient this deployment will open
      const browser = await bff();
      const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();
      const started = await browser.go("/auth/login");
      const back = await browser.authorize(started.location, ORY_USERS.alice);
      const held = (await codec.transient.unseal(browser.held("__Host-oidc")).get()) ?? {};
      browser.plant(
        "__Host-oidc",
        await codec.transient.seal({ ...held, nonce: "not-the-nonce-that-was-asked-for" }).get(),
      );

      // WHEN the callback is presented with a code that is otherwise valid
      const refused = await browser.go(`/auth/callback${back.search}`);
      const fragment = await browser.go("/orders/1/row");

      // THEN `expectedNonce` is what refuses it: the state matched and the code
      // was real, and the ID token is still bound to a nonce this end did not
      // ask for — which is also what forces an ID token to be present at all
      expect({
        status: refused.status,
        cookies: refused.setCookie,
        observed: browser
          .observations()
          .find((seen) => seen.component === "oidc" && seen.name === "callback"),
        fragment: fragment.status,
      }).toEqual({
        status: 401,
        cookies: [CLEARED],
        observed: expect.objectContaining({
          attributes: { reason: "grant_failed" },
          outcome: "error",
        }),
        fragment: 303,
      });
    },
    START_UP,
  );

  it(
    "refuses a return path that leaves the site",
    async ({ bff }) => {
      // GIVEN a login asked to come back to a protocol-relative URL
      const browser = await bff();

      // WHEN the whole flow is walked
      const back = await browser.login(ORY_USERS.alice, "?return=//evil.example");

      // THEN the login still succeeds and lands on this site's root: the
      // browser is never handed a destination it did not come from
      expect({ status: back.status, location: back.location }).toEqual({
        status: 303,
        location: "/",
      });
    },
    START_UP,
  );

  it(
    "decodes the return path exactly once, so a doubly-encoded backslash never becomes one",
    async ({ bff }) => {
      // GIVEN `%252F%255Cevil.com` — which is `/\evil.com` after TWO decodes,
      // and `new URL("/\\evil.com", base)` resolves to `https://evil.com/`
      const browser = await bff();

      // WHEN the flow is walked with it
      const back = await browser.login(ORY_USERS.alice, "?return=%252F%255Cevil.com");

      // THEN the one decode the query parser does is the only one: what the
      // guard sees is a literal `%2F%5Cevil.com`, which is not a path here
      expect({ status: back.status, location: back.location }).toEqual({
        status: 303,
        location: "/",
      });
    },
    START_UP,
  );

  it(
    "encodes a return path carrying a control character rather than splitting a header",
    async ({ bff }) => {
      // GIVEN `/%0aSet-Cookie:%20pwn=1` — one decode short of a `Location`
      // holding a CR/LF, which `writeHead` refuses as `ERR_INVALID_CHAR`
      const browser = await bff();

      // WHEN the flow is walked with it
      const back = await browser.login(ORY_USERS.alice, "?return=/%0aSet-Cookie:%20pwn=1");

      // THEN the `Location` carries it percent-encoded: there is no second
      // header, and no 500 on a request that has already spent the user's code
      expect({ status: back.status, location: back.location }).toEqual({
        status: 303,
        location: "/%0ASet-Cookie:%20pwn=1",
      });
    },
    START_UP,
  );

  it(
    "lands a browser on the path it was sent from, encoded exactly as it sent it",
    async ({ bff }) => {
      // GIVEN the value the htmx seam mints for a browser target of
      // `/orders/a%20b/row`: the target the browser already percent-encoded,
      // encoded once more as a query component
      const browser = await bff();

      // WHEN the flow is walked with it
      const back = await browser.login(ORY_USERS.alice, "?return=%2Forders%2Fa%2520b%2Frow");

      // THEN the `Location` is the browser's own target, not a second encoding
      // of it — a `%20` stays `%20`, never `%2520`
      expect({ status: back.status, location: back.location }).toEqual({
        status: 303,
        location: "/orders/a%20b/row",
      });
    },
    START_UP,
  );

  it(
    "encodes a return path a header cannot carry, rather than 500ing on it",
    async ({ bff }) => {
      // GIVEN `/订单/1` — an ordinary non-Latin-1 path, and Node's header
      // validator refuses every code point above U+00FF
      const browser = await bff();

      // WHEN the flow is walked with it
      const back = await browser.login(ORY_USERS.alice, "?return=%2F%E8%AE%A2%E5%8D%95%2F1");

      // THEN the browser is sent where it was going, percent-encoded — a guard
      // that only refused control characters would have kept this whole and
      // then `ERR_INVALID_CHAR`ed the callback with the code already spent
      expect({ status: back.status, location: back.location }).toEqual({
        status: 303,
        location: "/%E8%AE%A2%E5%8D%95/1",
      });
    },
    START_UP,
  );

  it(
    "names a provider that refused, rather than reporting it as a bad code",
    async ({ bff }) => {
      // GIVEN a callback the provider sent with `error=access_denied` — the
      // user clicked Deny — carrying the `state` this end asked with
      const browser = await bff();
      const started = await browser.go("/auth/login");
      const state = new URL(started.location ?? ABSENT).searchParams.get("state") ?? "";

      // WHEN it arrives
      const refused = await browser.go(
        `/auth/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=user+said+no`,
      );

      // THEN it is a 401 like any refused credential, and the provider's own
      // reason is written down — where the grant below would have reported it
      // as an indistinguishable exchange failure
      expect({
        status: refused.status,
        cookies: refused.setCookie,
        observed: browser
          .observations()
          .find((seen) => seen.component === "oidc" && seen.name === "callback"),
      }).toEqual({
        status: 401,
        cookies: [CLEARED],
        observed: {
          component: "oidc",
          name: "callback",
          // The reason is a DIMENSION and is bounded; the provider's own text
          // is caller-controlled, so it rides the cause and never an
          // instrument.
          attributes: { reason: "provider_refused" },
          outcome: "error",
          cause: expect.objectContaining({ message: "access_denied: user said no" }),
        },
      });
    },
    START_UP,
  );

  it(
    "passes `as` to the provider as login_hint",
    async ({ bff }) => {
      // GIVEN a login route asked who is signing in
      const browser = await bff();

      // WHEN the browser is sent out
      const started = await browser.go(`/auth/login?as=${encodeURIComponent(ORY_USERS.bob.email)}`);

      // THEN the hint rides the authorization request, which is what lets a
      // provider prefill its own form
      expect(new URL(started.location ?? ABSENT).searchParams.get("login_hint")).toBe(
        ORY_USERS.bob.email,
      );
    },
    START_UP,
  );

  it(
    "logs out: clears the cookie and sends the browser to the provider's end-session",
    async ({ bff }) => {
      // GIVEN a browser that is logged in
      const browser = await bff();
      await browser.login(ORY_USERS.alice, "?return=/orders/1/row");

      // WHEN it posts to the logout route, presenting the same-site evidence a
      // form post carries — the session scheme turned CSRF on
      const out = await browser.go("/auth/logout", {
        method: "POST",
        headers: { origin: browser.origin },
      });
      const fragment = await browser.go("/orders/1/row");

      // THEN the session cookie is cleared here and the provider is asked to
      // end its own session with nothing but the client id `openid-client`
      // puts there itself — no `id_token_hint`, which the cookie does not
      // carry, and no `post_logout_redirect_uri`, which Hydra refuses without
      // one — and the fragment is behind the login again
      expect({
        status: out.status,
        location: out.location,
        cookies: out.setCookie,
        fragment: fragment.status,
      }).toEqual({
        status: 303,
        location: `${ORY_ISSUER}oauth2/sessions/logout?client_id=${ORY_CLIENT_ID}`,
        cookies: ["__Host-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"],
        fragment: 303,
      });
    },
    START_UP,
  );

  it(
    "answers 404 for a path under its mount that names no route",
    async ({ bff }) => {
      // GIVEN an answerer that owns every path under `/auth`
      const browser = await bff();

      // WHEN one it serves no route for is asked
      const nothing = await browser.go("/auth/whatever");

      // THEN it answers itself rather than leaving the request to an answerer
      // mounted shallower
      expect({ status: nothing.status, text: nothing.text }).toEqual({ status: 404, text: "" });
    },
    START_UP,
  );

  it(
    "refuses a login whose claims the application declines",
    async ({ bff }) => {
      // GIVEN a deployment whose `principal` will not take these claims — the
      // hook for a tenant this application requires and the standard does not
      const browser = await bff(() => undefined);

      // WHEN a real user completes a real flow
      const back = await browser.login(ORY_USERS.alice);

      // THEN the login is refused with no session sealed: the provider said
      // who they are, and this application still does not know them
      expect({
        status: back.status,
        cookies: back.setCookie,
        observed: browser
          .observations()
          .find((seen) => seen.component === "oidc" && seen.name === "callback"),
      }).toEqual({
        status: 400,
        cookies: [CLEARED],
        observed: {
          component: "oidc",
          name: "callback",
          attributes: { reason: "principal_refused" },
          outcome: "error",
        },
      });
    },
    START_UP,
  );

  it("fails the boot with OidcUnreachable naming the issuer when discovery cannot run", async ({
    oidcApp,
  }) => {
    // GIVEN an issuer on a port nothing is listening on
    const app = oidcApp({ ...oidcEnv, HTTP_OIDC_ISSUER: "http://127.0.0.1:1/" });

    // WHEN the application boots
    // THEN discovery running ONCE at startup is what makes this a typed
    // startup failure naming the issuer, rather than a 500 on the first login
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        constructor: OidcUnreachable,
        issuer: "http://127.0.0.1:1/",
      }),
    );
  });

  it("takes an IPv6 loopback issuer as this machine's own too", async ({ oidcApp }) => {
    // GIVEN an `http:` issuer on `[::1]`, a port nothing is listening on —
    // `url.hostname` keeps the brackets, which is what the allowance must match
    const app = oidcApp({ ...oidcEnv, HTTP_OIDC_ISSUER: "http://[::1]:1/" });

    // WHEN the application boots
    // THEN the posture check lets it through and discovery is what fails,
    // naming the issuer — the same shape as the IPv4 loopback above
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        constructor: OidcUnreachable,
        issuer: "http://[::1]:1/",
      }),
    );
  });

  it("refuses a cleartext issuer that is not on this machine", async ({ oidcApp }) => {
    // GIVEN an `http:` issuer on a host that is not loopback — a deployment
    // that would send the client secret and every token over the open wire,
    // with `allowInsecureRequests` turning off the check that says so
    const app = oidcApp({ ...oidcEnv, HTTP_OIDC_ISSUER: "http://issuer.example/" });

    // WHEN the application boots
    // THEN it does not, and the variable is named: `Config.url` says a value
    // parses, not that it is safe, so the posture is checked where it is bound
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpOidc",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining("https:"),
            path: ["HTTP_OIDC_ISSUER"],
          }),
        ],
      }),
    );
  });

  it("refuses that issuer spelled with an upper-case scheme too", async ({ oidcApp }) => {
    // GIVEN the same issuer as `Config.url` accepts it — parsed, not normalised,
    // so the scheme arrives as the deployment typed it
    const app = oidcApp({ ...oidcEnv, HTTP_OIDC_ISSUER: "HTTP://issuer.example/" });

    // WHEN the application boots
    // THEN the posture is decided on the parsed scheme, and a spelling is not
    // a way around it
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpOidc",
        issues: [expect.objectContaining({ path: ["HTTP_OIDC_ISSUER"] })],
      }),
    );
  });

  it(
    "takes the same cleartext issuer once the deployment opted in at the call",
    async ({ oidcApp }) => {
      // GIVEN the same issuer, and `allowInsecureIssuer: true` pinned on
      // `oidc()` — an OPTION, because its silent change is a security
      // regression rather than a deployment detail
      const app = oidcApp({ ...oidcEnv, HTTP_OIDC_ISSUER: "http://issuer.example/" }, true);

      // WHEN the application boots
      // THEN configuration accepts it and the boot gets as far as discovery,
      // which is the next thing to fail — the posture gate is behind it
      await expect(app.exited).toBeErrWith(
        expect.objectContaining({
          constructor: OidcUnreachable,
          issuer: "http://issuer.example/",
        }),
      );
    },
    START_UP,
  );

  it("names a missing HTTP_OIDC_CLIENT_ID at boot", async ({ oidcApp }) => {
    // GIVEN a deployment that configured the issuer, the secret and the
    // redirect URI, and forgot the client id
    const app = oidcApp({
      HTTP_SESSION_KEYS: oidcEnv["HTTP_SESSION_KEYS"],
      HTTP_OIDC_ISSUER: ORY_ISSUER,
      HTTP_OIDC_CLIENT_SECRET: ORY_CLIENT_SECRET,
      HTTP_OIDC_REDIRECT_URI: ORY_REDIRECT_URI,
    });

    // WHEN the application boots
    // THEN it is a `ConfigInvalid` naming the variable, before a single
    // request — the same shape every other starter's configuration takes
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpOidc",
        issues: [{ message: "is required", path: ["HTTP_OIDC_CLIENT_ID"] }],
      }),
    );
  });
});
