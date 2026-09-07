import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { localIssuer } from "./jwt.js";

describe("localIssuer", () => {
  it("serves the public key as a JWKS at the URL it answers", async ({ issuer }) => {
    // GIVEN a local issuer serving its JWKS over http
    // WHEN its JWKS endpoint is fetched
    const response = await fetch(issuer.jwks);
    const body: unknown = await response.json();

    // THEN it answers JSON, and the published key carries this issuer's kid, algorithm and use
    expect({ contentType: response.headers.get("content-type"), body }).toEqual({
      contentType: "application/json",
      body: { keys: [expect.objectContaining({ kid: "k1", alg: "RS256", use: "sig" })] },
    });
  });

  it("signs a token the JWKS verifies", async ({ issuer }) => {
    // GIVEN a token this issuer signed
    const token = await issuer.sign({ sub: "u" }).get();

    // WHEN it is verified against the issuer's own JWKS
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(issuer.jwks)), {
      issuer: issuer.issuer,
      audience: issuer.audience,
    });

    // THEN the payload carries the claim and the issuer's own iss/aud
    expect(payload).toEqual(
      expect.objectContaining({ sub: "u", iss: issuer.issuer, aud: issuer.audience }),
    );
  });

  it("overrides issuer, audience and expiry on request", async ({ issuer }) => {
    // GIVEN a token signed with all three overridden, and no expiry at all
    const token = await issuer
      .sign({}, { issuer: "https://another.test", audience: "another-api", expiresIn: false })
      .get();

    // WHEN it is decoded
    const claims = decodeJwt(token);

    // THEN the overrides won and no exp claim was minted
    expect({ iss: claims.iss, aud: claims.aud, exp: claims.exp }).toEqual({
      iss: "https://another.test",
      aud: "another-api",
      exp: undefined,
    });
  });

  it("signs with the algorithm it was asked for", async () => {
    // GIVEN an issuer minted with the ES256 algorithm, not the shared fixture's default
    const built = await localIssuer({
      issuer: "https://issuer.test",
      audience: "orders-api",
      algorithm: "ES256",
    }).get();
    const token = await built.sign().get();
    await built.close();

    // WHEN the token's own header is read
    // THEN it names the algorithm this issuer was asked for
    expect(decodeProtectedHeader(token)).toEqual(expect.objectContaining({ alg: "ES256" }));
  });

  it("publishes the key of the algorithm it was asked for", async () => {
    // GIVEN an issuer minted with the ES256 algorithm
    const built = await localIssuer({
      issuer: "https://issuer.test",
      audience: "orders-api",
      algorithm: "ES256",
    }).get();
    await built.close();

    // WHEN the published key is read
    // THEN it is an EC key advertising ES256
    expect(built.jwk).toEqual(expect.objectContaining({ alg: "ES256", kty: "EC" }));
  });

  it("answers Ok when its listener closes", async () => {
    // GIVEN a standalone issuer, not the one shared with the other tests
    const built = await localIssuer({
      issuer: "https://issuer.test",
      audience: "orders-api",
    }).get();

    // WHEN it is closed
    // THEN the close itself reports success
    await expect(built.close()).toBeOk();
  });

  it("stops serving its JWKS once closed", async () => {
    // GIVEN a standalone issuer that has already closed
    const built = await localIssuer({
      issuer: "https://issuer.test",
      audience: "orders-api",
    }).get();
    await built.close();

    // WHEN its JWKS is fetched again
    // THEN the fetch rejects — nothing is listening any more
    await expect(fetch(built.jwks)).rejects.toThrow();
  });
});
