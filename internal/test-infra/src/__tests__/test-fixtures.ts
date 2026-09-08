import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { JWK } from "jose";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";
import { test } from "vitest";

import { devKeyPair, jwksUri, sharedJwks } from "../dev-issuer.js";
import { headlessLogin, oryClient } from "../ory-login.js";
import { ORY_REDIRECT_URI, ORY_SCOPE, sharedOry, type Ory, type OryUser } from "../ory.js";

// Anchored the same way `lock.ts` anchors its own `LOCKS`, one directory
// deeper. A spec that computed this from `process.cwd()` would silently point
// somewhere else the moment vitest is run from the repository root.
const LOCKS = fileURLToPath(new URL("../../../../.cache/test-infra-locks/", import.meta.url));

type Lock = {
  /** A name nobody else holds, so a spec never queues behind a real test run. */
  readonly name: string;
  /** Leave a lock behind as `pid` would have, without going through `withLock`. */
  readonly plant: (pid: number) => void;
};

/** The dev issuer, minted into a throwaway cache so a spec never touches `<repo>/.cache/dev-issuer`. */
type DevIssuer = {
  readonly cache: URL;
  readonly publicJwk: JWK;
  /** The URL `.env.dev` would carry, on the container this fixture started. */
  readonly jwks: string;
};

/** Sign a user in and exchange the code, so a test names only the user. */
type Login = (user: OryUser) => Promise<Awaited<ReturnType<typeof authorizationCodeGrant>>>;

export const it = test.extend<{
  lock: Lock;
  deadPid: number;
  keyCache: URL;
  issuer: DevIssuer;
  ory: Ory;
  oidc: Configuration;
  login: Login;
}>({
  lock: async ({}, use) => {
    const name = `spec-${randomUUID()}`;
    const path = `${LOCKS}${name}.lock`;
    await use({
      name,
      plant: (pid) => {
        mkdirSync(path, { recursive: true });
        writeFileSync(`${path}/pid`, String(pid), "utf8");
      },
    });
    rmSync(path, { recursive: true, force: true });
  },

  // A pid that is certainly not running, rather than one assumed too high to
  // exist: the ceiling differs between macOS and Linux, and a pid that happened
  // to be live would make the staleness test hang instead of fail.
  deadPid: async ({}, use) => {
    await use(spawnSync(process.execPath, ["-e", ""]).pid);
  },

  // File-scoped, both of them: a throwaway key is a container nothing else
  // shares — the thumbprint is part of the reuse hash — so a key per TEST
  // would start an nginx per test and leave it behind.
  keyCache: [
    async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), "dev-issuer-"));
      // A trailing slash, so `new URL("private.jwk", cache)` resolves inside it
      // rather than beside it.
      const cache = new URL(`${pathToFileURL(directory).href}/`);
      await use(cache);
      await rm(cache, { recursive: true, force: true });
    },
    { scope: "file" },
  ],

  // Stopped rather than left to outlive the run the way the six long-lived
  // ones are, for the same reason: nothing else will ever match its hash.
  issuer: [
    async ({ keyCache }, use) => {
      const { publicJwk } = await devKeyPair(keyCache);
      const container = await sharedJwks(publicJwk);
      await use({ cache: keyCache, publicJwk, jwks: jwksUri(container) });
      await container.stop();
    },
    { scope: "file" },
  ],

  // File-scoped, and NOT stopped afterwards: these three are long-lived shared
  // containers like the rest of the set, so a spec attaches to them rather
  // than owning them.
  ory: [
    async ({}, use) => {
      await use(await sharedOry());
    },
    { scope: "file" },
  ],

  // Every subtlety of building this lives in `oryClient`, exported so a spec in
  // another workspace does not re-derive it and quietly drop one.
  oidc: [
    async ({ ory: _ory }, use) => {
      await use(await oryClient());
    },
    { scope: "file" },
  ],

  login: async ({ oidc }, use) => {
    await use(async (user) => {
      const pkceCodeVerifier = randomPKCECodeVerifier();
      const state = randomState();
      const authorizationUrl = buildAuthorizationUrl(oidc, {
        redirect_uri: ORY_REDIRECT_URI,
        scope: ORY_SCOPE,
        code_challenge: await calculatePKCECodeChallenge(pkceCodeVerifier),
        code_challenge_method: "S256",
        state,
      });

      return authorizationCodeGrant(oidc, await headlessLogin({ authorizationUrl, user }), {
        pkceCodeVerifier,
        expectedState: state,
      });
    });
  },
});
