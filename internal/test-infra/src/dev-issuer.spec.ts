import { createRemoteJWKSet, jwtVerify } from "jose";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { DEV_AUDIENCE, DEV_ISSUER, devKeyPair, signDevToken } from "./dev-issuer.js";

const TENANT = "0199a1e0-0000-7000-8000-000000000001";

describe("the dev issuer", () => {
  it("mints its key pair once and hands the same one back", async ({ keyCache }) => {
    // GIVEN a cache directory with no key pair in it yet
    const first = await devKeyPair(keyCache);

    // WHEN a later run asks for one
    const second = await devKeyPair(keyCache);

    // THEN it was read back rather than regenerated, which is what makes a
    // token minted yesterday still verify today
    expect({ first, second }).toEqual({
      first: {
        privateJwk: expect.objectContaining({ kid: "dev", alg: "RS256" }),
        publicJwk: expect.objectContaining({ kid: "dev", alg: "RS256", use: "sig" }),
      },
      second: first,
    });
  });

  it("serves that key pair's public half as a JWKS", async ({ issuer }) => {
    // GIVEN the container `.env.dev` points `HTTP_JWT_JWKS_URI` at

    // WHEN it is fetched the way `createRemoteJWKSet` fetches it
    // THEN the one key it publishes is the persisted public half
    await expect(fetch(issuer.jwks).then((response) => response.json())).resolves.toEqual({
      keys: [issuer.publicJwk],
    });
  }, 60_000);

  it("signs a token that verifies against that JWKS", async ({ issuer }) => {
    // GIVEN a token minted the way `pnpm dev:token` mints one
    const token = await signDevToken(
      { tenant: TENANT, sub: "u-1", scope: "orders:export" },
      issuer.cache,
    );

    // WHEN it is verified against the served keys, under the issuer and
    // audience `.env.dev` writes beside them
    // THEN the three claims `order-api`'s own `principal` reads are there
    await expect(
      jwtVerify(token, createRemoteJWKSet(new URL(issuer.jwks)), {
        issuer: DEV_ISSUER,
        audience: DEV_AUDIENCE,
      }).then((verified) => verified.payload),
    ).resolves.toEqual(
      expect.objectContaining({ tenant: TENANT, sub: "u-1", scope: "orders:export" }),
    );
  }, 60_000);
});
