import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("jwtVerifier", () => {
  it("should verify signed evidence for its expected audience", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller", tenant: "acme" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeOkWith(
      expect.objectContaining({
        sub: "caller",
        tenant: "acme",
        iss: issuer.issuer,
        aud: issuer.audience,
      }),
    );
  });

  it("should refuse service A evidence when service B is expected", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }, { audience: "service-a" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: "service-b" });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should verify a different audience through the same issuer verifier", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }, { audience: "another-service" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: "another-service" });

    // THEN
    expect(result).toBeOkWith(expect.objectContaining({ aud: "another-service" }));
  });

  it("should reuse cached issuer keys across expected audiences", async ({ rotation }) => {
    // GIVEN
    const first = await rotation.sign("service-a");
    await rotation.service.verify({ token: first, audience: "service-a" }).getOrThrow();
    const second = await rotation.sign("service-b");

    // WHEN
    await rotation.service.verify({ token: second, audience: "service-b" }).getOrThrow();

    // THEN
    expect(rotation.requests()).toBe(1);
  });

  it("should verify a rotated signing key after the shared key-set cooldown", async ({
    rotation,
  }) => {
    // GIVEN
    const first = await rotation.sign("service-a");
    await rotation.service.verify({ token: first, audience: "service-a" }).getOrThrow();
    rotation.rotate();
    const second = await rotation.sign("service-b");

    // WHEN
    const result = await rotation.service.verify({ token: second, audience: "service-b" });

    // THEN
    expect(result).toBeOkWith(expect.objectContaining({ sub: "caller", aud: "service-b" }));
  });

  it("should bind a second verifier through its application-owned port", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }).get();

    // WHEN
    const result = await verification.custom.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeOkWith(expect.objectContaining({ sub: "caller" }));
  });

  it("should refuse a blank expected audience", async ({ issuer, verification }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: "   " });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should refuse evidence from another issuer", async ({ issuer, verification }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }, { issuer: "https://other.example" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should refuse expired evidence", async ({ issuer, verification }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }, { expiresIn: "-1s" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should require an expiry on signed evidence", async ({ issuer, verification }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "caller" }, { expiresIn: false }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should honor a future not-before claim", async ({ issuer, verification }) => {
    // GIVEN
    const token = await issuer
      .sign({ sub: "caller", nbf: Math.floor(Date.now() / 1000) + 60 })
      .get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should refuse another key's signature", async ({ stranger, issuer, verification }) => {
    // GIVEN
    const token = await stranger.sign({ sub: "caller" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should refuse algorithm-confusion evidence", async ({ hmacToken, issuer, verification }) => {
    // GIVEN
    const token = await hmacToken.get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should refuse a key id the fetched key set does not publish", async ({
    forgedToken,
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await forgedToken({ alg: "RS256", kid: "unpublished" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it("should refuse a published key id under another algorithm", async ({
    forgedToken,
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await forgedToken({ alg: "ES256" }).get();

    // WHEN
    const result = await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("CredentialRefused");
  });

  it.for([
    { key_ops: "verify" },
    { key_ops: ["sign"] },
    { key_ops: ["verify", "verify"] },
    { key_ops: [1] },
    { use: "enc" },
    { ext: "true" },
  ])(
    "should report published key metadata %o that no token can use",
    async (metadata, { misdeclared }) => {
      // GIVEN
      misdeclared.publish(metadata);
      const token = await misdeclared.sign();

      // WHEN
      const result = await misdeclared.service.verify({ token, audience: misdeclared.audience });

      // THEN
      expect(result).toBeErrTagged("AuthenticatorUnavailable");
    },
  );

  it("should keep an unpublished key id out of observations", async ({
    forgedToken,
    issuer,
    verification,
  }) => {
    // GIVEN
    const token = await forgedToken({ alg: "RS256", kid: "unpublished" }).get();

    // WHEN
    await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(verification.observations).toEqual([]);
  });

  it("should keep refused credentials out of observations", async ({ issuer, verification }) => {
    // GIVEN
    const token = await issuer.sign({ sub: "private-subject" }, { audience: "wrong-target" }).get();

    // WHEN
    await verification.service.verify({ token, audience: issuer.audience });

    // THEN
    expect(verification.observations).toEqual([]);
  });

  it("should distinguish unreachable issuer keys from refused evidence", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const service = await verification
      .configured({
        issuer: issuer.issuer,
        jwks: "http://127.0.0.1:1/jwks",
      })
      .getOrThrow();
    const token = await issuer.sign({ sub: "caller" }).get();

    // WHEN
    const result = await service.verify({ token, audience: issuer.audience });

    // THEN
    expect(result).toBeErrTagged("AuthenticatorUnavailable");
  });

  it("should read issuer trust without a fixed audience variable", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const environment = { HTTP_JWT_ISSUER: issuer.issuer, HTTP_JWT_JWKS_URI: issuer.jwks };

    // WHEN
    const result = await verification.configured({}, environment);

    // THEN
    expect(result).toBeOkWith(expect.objectContaining({ verify: expect.any(Function) }));
  });

  it("should honor its own deployment prefix", async ({ issuer, verification }) => {
    // GIVEN
    const environment = { EVIDENCE_ISSUER: issuer.issuer, EVIDENCE_JWKS_URI: issuer.jwks };

    // WHEN
    const result = await verification.configured({ variablePrefix: "EVIDENCE" }, environment);

    // THEN
    expect(result).toBeOkWith(expect.objectContaining({ verify: expect.any(Function) }));
  });

  it("should reject missing issuer configuration at construction", async ({ verification }) => {
    // GIVEN
    const environment = {};

    // WHEN
    const result = await verification.configured({}, environment);

    // THEN
    expect(result).toBeErrTagged("ConfigInvalid");
  });

  it("should reject a malformed key-set URL at construction", async ({ issuer, verification }) => {
    // GIVEN
    const environment = { HTTP_JWT_ISSUER: issuer.issuer, HTTP_JWT_JWKS_URI: "not a URI" };

    // WHEN
    const result = await verification.configured({}, environment);

    // THEN
    expect(result).toBeErrTagged("ConfigInvalid");
  });

  it("should reject non-loopback cleartext issuer keys", async ({ issuer, verification }) => {
    // GIVEN
    const options = { issuer: issuer.issuer, jwks: "http://issuer.example/jwks" };

    // WHEN
    const result = await verification.configured(options);

    // THEN
    expect(result).toBeErrTagged("ConfigInvalid");
  });

  it("should allow an explicitly pinned insecure development key set", async ({
    issuer,
    verification,
  }) => {
    // GIVEN
    const options = {
      issuer: issuer.issuer,
      jwks: "http://issuer.example/jwks",
      allowInsecureJwks: true,
    };

    // WHEN
    const result = await verification.configured(options);

    // THEN
    expect(result).toBeOkWith(expect.objectContaining({ verify: expect.any(Function) }));
  });
});
