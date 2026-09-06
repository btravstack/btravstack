import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
} from "jose";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { shared } from "./containers.js";
import { withLock } from "./lock.js";

/** What `.env.dev` writes as `HTTP_JWT_ISSUER`, and what every dev token claims. */
export const DEV_ISSUER = "https://dev.btravstack.test";
/** What `.env.dev` writes as `HTTP_JWT_AUDIENCE`. */
export const DEV_AUDIENCE = "orders-api";

const ALGORITHM = "RS256";
const KID = "dev";

/**
 * Beside the file locks, for the same reason: repository-local rather than in
 * the OS temp directory, so a stale one is findable. Gitignored with the rest
 * of `.cache/`.
 */
const DEFAULT_CACHE = new URL("../../../.cache/dev-issuer/", import.meta.url);

type DevKeyPair = { readonly privateJwk: JWK; readonly publicJwk: JWK };

/**
 * The dev loop's signing key, minted on first use and reused for ever after —
 * which is the whole point: a token minted yesterday still verifies today, and
 * a `pnpm dev:env` between the two changes nothing.
 */
export const devKeyPair = (cache: URL = DEFAULT_CACHE): Promise<DevKeyPair> =>
  withLock("dev-issuer-key", async () => {
    const privateFile = new URL("private.jwk", cache);
    const publicFile = new URL("public.jwk", cache);

    const stored = await readFile(privateFile, "utf8").catch(() => undefined);
    if (stored !== undefined) {
      return {
        privateJwk: JSON.parse(stored) as JWK,
        publicJwk: JSON.parse(await readFile(publicFile, "utf8")) as JWK,
      };
    }

    const { publicKey, privateKey } = await generateKeyPair(ALGORITHM, { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: ALGORITHM, use: "sig" };
    const privateJwk = { ...(await exportJWK(privateKey)), kid: KID, alg: ALGORITHM };

    await mkdir(cache, { recursive: true });
    await writeFile(privateFile, JSON.stringify(privateJwk), { mode: 0o600 });
    await writeFile(publicFile, JSON.stringify(publicJwk));

    return { privateJwk, publicJwk };
  });

/**
 * The seventh shared container: nginx serving one static `/jwks.json`, so the
 * dev loop's `HTTP_JWT_JWKS_URI` is a real endpoint a real `createRemoteJWKSet`
 * fetches over the network.
 *
 * The key's thumbprint is a **label**, and labels are part of what
 * testcontainers hashes for reuse — so a new key pair produces a new container
 * rather than one still serving the old public half, which the copied file
 * alone could not express (the content is copied after create and is not
 * hashed).
 */
export const sharedJwks = async (publicJwk: JWK): Promise<StartedTestContainer> => {
  const thumbprint = await calculateJwkThumbprint(publicJwk);

  return shared("jwks", () =>
    new GenericContainer("nginx:1.29-alpine")
      .withExposedPorts(80)
      .withLabels({ "com.btravstack.dev-issuer-key": thumbprint })
      .withCopyContentToContainer([
        {
          content: JSON.stringify({ keys: [publicJwk] }),
          target: "/usr/share/nginx/html/jwks.json",
          mode: 0o644,
        },
      ])
      .withWaitStrategy(Wait.forListeningPorts()),
  );
};

/** Where {@link sharedJwks} publishes, as `.env.dev`'s `HTTP_JWT_JWKS_URI`. */
export const jwksUri = (jwks: StartedTestContainer): string =>
  `http://${jwks.getHost()}:${jwks.getMappedPort(80)}/jwks.json`;

/**
 * One token the dev loop's `order-api` accepts: `sub` is the user, `tenant` the
 * tenant, `scope` the space-delimited grant — the three claims the example's own
 * `principal` reads.
 */
export const signDevToken = async (
  claims: { readonly tenant: string; readonly sub: string; readonly scope: string },
  cache?: URL,
): Promise<string> => {
  const { privateJwk } = await devKeyPair(cache);
  const key = await importJWK(privateJwk, ALGORITHM);

  return new SignJWT({ tenant: claims.tenant, scope: claims.scope })
    .setProtectedHeader({ alg: ALGORITHM, kid: KID })
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
};
