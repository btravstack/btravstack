import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("jwtAuthenticator", () => {
  it("names the caller its claims describe, over a real JWKS fetch", async ({
    issuer,
    jwtService,
  }) => {
    // GIVEN a token this issuer signed, and its JWKS served over HTTP
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" });

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
    const token = await issuer.sign({
      sub: "u-1",
      tenant: "acme",
      scope: "orders:export billing:write",
    });

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
    const token = await issuer.sign({ sub: "u-1", tenant: "acme", scp: ["orders:export"] });

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
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }, { audience: "billing-api" });

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
    const token = await issuer.signWithoutExpiry();

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
    const token = await issuer.sign(
      { sub: "u-1", tenant: "acme" },
      { issuer: "https://evil.test" },
    );

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it is refused
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses an expired token", async ({ issuer, jwtService }) => {
    // GIVEN a token whose `exp` is in the past
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" }, { expiresIn: "-1s" });

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN it is refused — `clockToleranceSec` defaults to 0, so leeway is an
    // opt-in rather than a silent grace period
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses a token signed by a key the JWKS does not publish", async ({
    issuer,
    jwtService,
  }) => {
    // GIVEN a token signed with a private key whose public half is not served,
    // presented with a `kid` the JWKS does publish
    const token = await issuer.signWithStranger({ sub: "u-1", tenant: "acme" });

    // WHEN it is presented
    const resolved = await jwtService({
      authorization: `Bearer ${token}`,
    });

    // THEN the signature check refuses it: a matching `kid` is not a signature
    expect(resolved).toBeErrTagged("Unauthenticated");
  });

  it("refuses an HMAC token signed with a published public key", async ({ issuer, jwtService }) => {
    // GIVEN the algorithm-confusion attack: a JWKS publishes PUBLIC keys, so an
    // attacker signs `HS256` using the very JWK this issuer serves as the
    // shared secret — no key they do not already have
    const token = await issuer.signHmacWithPublicKey();

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
    const token = await issuer.sign({ sub: "u-1" });

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
    const token = await issuer.sign({ sub: "u-1", tenant: "acme" });

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
});
