import assert from "node:assert/strict";

import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("jwtAuthenticator", () => {
  it("names the caller its claims describe, over a real JWKS fetch", async ({
    issuer,
    jwtService,
  }) => {
    // GIVEN a token this issuer signed, and its JWKS served over HTTP
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }).get();

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN the claims became the application's own identity — the callback is
    // where a tenant enters, since no standard claim carries one
    expect(resolved).toBeOkWith({ tenantId: "acme", userId: "u-1" });
  });

  it("grants only the scopes the scheme declares, whatever the token claims", async ({
    issuer,
    scopedJwtService,
  }) => {
    // GIVEN a token claiming a scope the scheme knows and one it does not
    const token = await issuer
      .sign({
        sub: "u-1",
        tenant: "acme",
        scope: "orders:export billing:write",
      })
      .get();

    // WHEN it is presented to a scheme whose vocabulary is the first alone
    const resolved = await scopedJwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN the grant is the INTERSECTION: a token claiming a scope this scheme
    // does not know grants nothing extra, so a compromised issuer cannot widen
    // what an endpoint accepts
    expect(resolved).toBeOkWith(
      expect.objectContaining({
        identity: { tenantId: "acme", userId: "u-1" },
        scopes: ["orders:export"],
      }),
    );
  });

  it("reads an array `scp` claim as well as a space-delimited `scope`", async ({
    issuer,
    scopedJwtService,
  }) => {
    // GIVEN a token in the shape Entra and Okta mint
    const token = await issuer.sign({ sub: "u-1", tenant: "acme", scp: ["orders:export"] }).get();

    // WHEN it is presented
    const resolved = await scopedJwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it grants the same as the RFC 8693 spelling — both are in the wild
    // and neither is guaranteed
    expect(resolved).toBeOkWith(expect.objectContaining({ scopes: ["orders:export"] }));
  });

  it("refuses a token minted for another audience", async ({ issuer, jwtService }) => {
    // GIVEN a token this issuer signed for a sibling service
    const token = await issuer
      .sign({ sub: "u-1", tenant: "acme" }, { audience: "billing-api" })
      .get();

    // WHEN it is presented here
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it is refused. This is the check whose absence lets a token from a
    // sibling service be replayed against this one
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a token carrying no `exp` at all", async ({ issuer, jwtService }) => {
    // GIVEN a properly signed token from the right issuer for the right
    // audience, with no expiry claim
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }, { expiresIn: false }).get();

    // WHEN it is presented
    const resolved = await jwtService({ authorization: `Bearer ${token}` });

    // THEN it is refused. `jose` validates `exp` only when it is PRESENT, so
    // without `requiredClaims` this token authenticates and never expires —
    // which is what the documentation claiming `exp` is required would have
    // been describing wrongly
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a token from another issuer", async ({ issuer, jwtService }) => {
    // GIVEN a token whose `iss` is not the one configured
    const token = await issuer
      .sign({ sub: "u-1", tenant: "acme" }, { issuer: "https://evil.test" })
      .get();

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it is refused
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses an expired token", async ({ issuer, jwtService }) => {
    // GIVEN a token whose `exp` is in the past
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }, { expiresIn: "-1s" }).get();

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it is refused — `clockToleranceSec` defaults to 0, so leeway is an
    // opt-in rather than a silent grace period
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a token signed by a key the JWKS does not publish", async ({
    stranger,
    jwtService,
  }) => {
    // GIVEN a token signed with a private key whose public half is not served,
    // presented with a `kid` the JWKS does publish
    const token = await stranger.sign({ sub: "u-1", tenant: "acme" }).get();

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN the signature check refuses it: a matching `kid` is not a signature
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses an HMAC token signed with a published public key", async ({
    hmacToken,
    jwtService,
  }) => {
    // GIVEN the algorithm-confusion attack: a JWKS publishes PUBLIC keys, so an
    // attacker signs `HS256` using the very JWK this issuer serves as the
    // shared secret — no key they do not already have
    const token = await hmacToken.get();

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN the algorithm allowlist refuses it before any key is consulted —
    // which is why `DEFAULT_ALGORITHMS` is asymmetric-only and why the list
    // exists at all rather than being left implicit
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a valid token whose claims the application will not accept", async ({
    issuer,
    jwtService,
  }) => {
    // GIVEN a properly signed token with no `tenant` claim
    const token = await issuer.sign({ sub: "u-1" }).get();

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN `principal` answering `undefined` is a REFUSAL rather than a
    // principal of `undefined` — a handler with a context that type-checks and
    // an unauthenticated caller inside it
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a request carrying no bearer token", async ({ jwtService }) => {
    // GIVEN a header in the wrong scheme
    // WHEN it is presented
    const resolved = await jwtService({ authorization: "Basic abc" });

    // THEN it is refused before the JWKS is ever consulted
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("grants nothing when the token carries no scope claim at all", async ({
    issuer,
    scopedJwtService,
  }) => {
    // GIVEN a scoped scheme and a token claiming neither `scope` nor `scp` —
    // the ordinary shape of a token from an issuer that does not do scopes
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }).get();

    // WHEN it is presented
    const resolved = await scopedJwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it is authenticated and grants nothing, which is what leaves the
    // 403 to the endpoint's own scope check rather than a 401 here
    expect(resolved).toBeOkWith(
      expect.objectContaining({ identity: { tenantId: "acme", userId: "u-1" }, scopes: [] }),
    );
  });

  it("binds jwks, issuer and audience from HTTP_JWT_* when nothing is pinned", async ({
    issuer,
    jwtApp,
  }) => {
    // GIVEN a scheme that pins none of the three, and a deployment naming them
    const app = jwtApp({
      HTTP_JWT_JWKS_URI: issuer.jwks,
      HTTP_JWT_ISSUER: issuer.issuer,
      HTTP_JWT_AUDIENCE: issuer.audience,
    });
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }).get();

    // WHEN a token that issuer signed is presented to a protected route
    const response = await fetch(`http://127.0.0.1:${info.port}/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });

    // THEN the caller is named — the environment configured the scheme, and no
    // code change was needed to point this deployment at that issuer
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 200,
      body: "u-1",
    });
  });

  it("fails startup with ConfigInvalid naming a variable nobody set", async ({
    issuer,
    jwtApp,
  }) => {
    // GIVEN a deployment that configured the JWKS and the audience and forgot
    // the issuer
    const app = jwtApp({
      HTTP_JWT_JWKS_URI: issuer.jwks,
      HTTP_JWT_AUDIENCE: issuer.audience,
    });

    // WHEN the application boots
    // THEN it does not serve: an unset variable nobody pinned is a modeled
    // startup Err naming it, not a scheme that refuses every caller forever
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpJwt",
        issues: [{ message: "is required", path: ["HTTP_JWT_ISSUER"] }],
      }),
    );
  });

  it("fails startup with ConfigInvalid when HTTP_JWT_JWKS_URI is not a URL", async ({
    issuer,
    jwtApp,
  }) => {
    // GIVEN a JWKS endpoint an operator wrote without its scheme
    const app = jwtApp({
      HTTP_JWT_JWKS_URI: "issuer.example/.well-known/jwks.json",
      HTTP_JWT_ISSUER: issuer.issuer,
      HTTP_JWT_AUDIENCE: issuer.audience,
    });

    // WHEN the application boots
    // THEN it is the same modeled Err naming the variable — `Config.url` is
    // what keeps `new URL` from throwing inside the piece's `make` and turning
    // the likeliest operator typo into an unnamed Defect
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpJwt",
        issues: [
          {
            message: 'is not a URL: "issuer.example/.well-known/jwks.json"',
            path: ["HTTP_JWT_JWKS_URI"],
          },
        ],
      }),
    );
  });

  it("takes a pinned option over the variable that would otherwise bind it", async ({
    issuer,
    pinnedAudienceJwt,
  }) => {
    // GIVEN `audience` pinned, and an environment naming a different one
    const authenticate = (await pinnedAudienceJwt({ HTTP_JWT_AUDIENCE: "ignored" })).getOrThrow();
    const forPin = await issuer.sign({ sub: "u-1", tenant: "acme" }, { audience: "pinned" }).get();
    const forVariable = await issuer
      .sign({ sub: "u-1", tenant: "acme" }, { audience: "ignored" })
      .get();

    // WHEN a token for each audience is presented
    const pinned = await authenticate({ authorization: `Bearer ${forPin}` });
    const variable = await authenticate({ authorization: `Bearer ${forVariable}` });

    // THEN the pin decided both answers: explicit beats environment, per field
    expect({ pinned: pinned.isOk(), variable: variable.isOk() }).toEqual({
      pinned: true,
      variable: false,
    });
  });

  it("refuses a cleartext JWKS endpoint at boot, unless it is loopback", async ({
    issuer,
    jwtApp,
  }) => {
    // GIVEN a deployment pointing the key set at a plaintext host that is not
    // this machine — the shape a staging environment reaches for
    const app = jwtApp({
      HTTP_JWT_JWKS_URI: "http://keys.internal/.well-known/jwks.json",
      HTTP_JWT_ISSUER: issuer.issuer,
      HTTP_JWT_AUDIENCE: issuer.audience,
    });

    // WHEN the application boots
    // THEN it is a `ConfigInvalid` naming the variable, before a single
    // request. `Config.url` only says the value PARSES; a key set fetched in
    // cleartext lets anything on the path publish its own signing key and mint
    // tokens this process then accepts. `oidc()` already refused a cleartext
    // issuer on the same rule, and the two used to disagree.
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpJwt",
        issues: [
          expect.objectContaining({
            path: ["HTTP_JWT_JWKS_URI"],
            // The WHOLE message, not a prefix: the option name and the call
            // it is pinned at are interpolated, and folding them into one
            // field once produced "`allowInsecureJwks` on `jwtAuthenticator():
            // true`" — the `: true` on the wrong half, backticks unbalanced,
            // and a prefix match that never noticed.
            message:
              "must be an https: URL — in cleartext anything on the path can substitute its own signing key and mint tokens this process accepts. Only a loopback host (localhost, 127.0.0.1, [::1]) is accepted without `allowInsecureJwks: true` on `jwtAuthenticator()`",
          }),
        ],
      }),
    );
  });

  it("fetches a loopback JWKS over plaintext, which is the dev loop", async ({
    issuer,
    jwtApp,
  }) => {
    // GIVEN this file's own issuer, which serves its key set from `127.0.0.1`
    // over plain HTTP
    const app = jwtApp({
      HTTP_JWT_JWKS_URI: issuer.jwks,
      HTTP_JWT_ISSUER: issuer.issuer,
      HTTP_JWT_AUDIENCE: issuer.audience,
    });

    // WHEN the application boots
    const info = (await app.runtimeInfo()).get();

    // THEN it served: plaintext that never leaves the machine is not the
    // attack the refusal above exists for, and refusing it would mean every
    // local suite and every `pnpm dev` had to opt out of a security default
    expect(info).toEqual(expect.objectContaining({ port: expect.any(Number) }));
  });

  it("reports a JWKS it cannot reach, rather than refusing in silence", async ({
    issuer,
    unreachableJwks,
  }) => {
    // GIVEN a scheme whose issuer's key set is not answering, and a token that
    // is otherwise perfectly good
    const scheme = await unreachableJwks();
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }).get();

    // WHEN it is presented
    await scheme.resolve({ authorization: `Bearer ${token}` });

    // THEN the outage settled an operation carrying a bounded reason and the
    // library's own cause. Unreported, a key-set incident refused every caller
    // at once as a bare `401` — an issuer outage presenting as the whole world
    // suddenly sending bad credentials, with nothing anywhere saying otherwise.
    expect(scheme.taken()).toEqual([
      expect.objectContaining({
        component: "jwt",
        name: "verify",
        outcome: "error",
        attributes: { reason: "issuer_unreachable" },
        cause: expect.anything(),
      }),
    ]);
  });

  it("says nothing about a token the caller got wrong", async ({ issuer, unreachableJwks }) => {
    // GIVEN the same recording scheme, and a request carrying no token at all —
    // the shape a caller controls
    const scheme = await unreachableJwks();
    void issuer;

    // WHEN it is presented
    const answered = await scheme.resolve({});

    // THEN it is refused and NOTHING was observed. A refused credential is not
    // an operation that failed, and a line per unauthenticated request is how a
    // scanner writes an application's logs for it.
    expect({ refused: answered.isErr(), observed: scheme.taken() }).toEqual({
      refused: true,
      observed: [],
    });
  });
});
