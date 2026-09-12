import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ORDERS_APP_PASSWORD,
  ORDERS_APP_USER,
  ORDERS_DATABASE,
  postgresUrl,
  provisionApplicationRole,
  sharedPostgres,
  sharedRabbitMq,
  RUSTFS_ACCESS_KEY,
  RUSTFS_BUCKET,
  RUSTFS_SECRET_KEY,
  sharedMailpit,
  sharedRedis,
  sharedRustFs,
  sharedTemporal,
} from "./containers.js";
import { DEV_AUDIENCE, DEV_ISSUER, devKeyPair, jwksUri, sharedJwks } from "./dev-issuer.js";
import { withLock } from "./lock.js";
import {
  ORY_CLIENT_ID,
  ORY_CLIENT_SECRET,
  ORY_ISSUER,
  ORY_REDIRECT_URI,
  sharedOry,
} from "./ory.js";

const run = promisify(execFile);
/**
 * Stays a `URL` all the way to `writeFile`, which accepts one: round-tripping it
 * through a path string works on POSIX and is wrong in general — a Windows path,
 * or a checkout under a directory with a space or a `#`, is mis-parsed.
 */
const envFile = new URL("../../../.env.dev", import.meta.url);
/**
 * The one workspace this script knows by path: it owns the schema and the
 * `prisma` CLI. The same `prisma migrate deploy` under the same lock as its own
 * `globalSetup`, because the dev loop and the gate share one database and
 * neither may assume it ran first.
 */
const infrastructure = fileURLToPath(
  new URL("../../../examples/order-infrastructure", import.meta.url),
);

const sessionKeysFile = new URL("../../../.cache/dev-session/keys", import.meta.url);

/**
 * The dev loop's session-sealing key, minted on first use and read back for
 * ever after — the dev issuer's key pair for the same reason: a cookie sealed
 * before a `pnpm dev:env` still opens after it.
 */
const devSessionKeys = (): Promise<string> =>
  withLock("dev-session-keys", async () => {
    const stored = await readFile(sessionKeysFile, "utf8").catch(() => undefined);
    if (stored !== undefined) return stored.trim();

    const key = randomBytes(32).toString("base64url");
    await mkdir(new URL(".", sessionKeysFile), { recursive: true });
    await writeFile(sessionKeysFile, key, { mode: 0o600 });

    return key;
  });

/**
 * Brings up the shared containers and writes the repository root's
 * `.env.dev` — what `turbo run dev` loads into each example process.
 *
 * The **same** containers the test suites use, attached to rather than
 * duplicated, so a warm machine pays nothing here and a `pnpm test` running
 * alongside shares them.
 *
 * Most of those ports are whatever Docker mapped, which is why the addresses are
 * written to a file rather than defaulted: an ephemeral mapped port cannot be a
 * default. The provider's are the exception and are fixed, because a redirect
 * protocol needs URLs a client and a browser agree on before anything starts —
 * so the `HTTP_OIDC_*` lines below are constants where the rest are readings.
 */
const main = async (): Promise<void> => {
  const postgres = await sharedPostgres();
  const ownerUrl = postgresUrl(postgres, ORDERS_DATABASE);

  const { publicJwk } = await devKeyPair();
  const [rabbitmq, temporal, redis, mailpit, rustfs, jwks, , sessionKeys] = await Promise.all([
    sharedRabbitMq(),
    sharedTemporal(postgres),
    sharedRedis(),
    sharedMailpit(),
    sharedRustFs(),
    sharedJwks(publicJwk),
    sharedOry(),
    devSessionKeys(),
  ]);

  await withLock("orders-migrate", () =>
    run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: infrastructure,
      env: { ...process.env, DATABASE_URL: ownerUrl },
    }),
  );

  // The owner migrates; the examples connect as the application role, which is
  // a non-superuser so that row security applies to it.
  await provisionApplicationRole(postgres);
  const databaseUrl = postgresUrl(postgres, ORDERS_DATABASE, {
    user: ORDERS_APP_USER,
    password: ORDERS_APP_PASSWORD,
  });

  const env = [
    "# Written by `pnpm dev` (internal/test-infra's dev:env). Not committed:",
    "# the ports are whatever Docker mapped for the shared containers.",
    `DATABASE_URL=${databaseUrl}`,
    `AMQP_URL=amqp://guest:guest@${rabbitmq.getHost()}:${rabbitmq.getMappedPort(5672)}`,
    `TEMPORAL_ADDRESS=${temporal.getHost()}:${temporal.getMappedPort(7233)}`,
    "TEMPORAL_NAMESPACE=default",
    // `order-api`'s root composes a cache, so omitting this exits 78 on a
    // `ConfigInvalid` naming the variable.
    `REDIS_URL=redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    // `order-amqp-worker`'s notifications slice sends mail, so a dev run
    // without this would exit 78 on a `ConfigInvalid` naming the variable.
    // Mailpit delivers nowhere and keeps everything, which is what a local
    // loop wants: http://localhost:<mapped 8025> is the mailbox.
    `SMTP_URL=smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
    // `order-temporal-worker`'s saga stores a confirmation, so a dev run
    // without these would exit 78 on a `ConfigInvalid` naming the first one
    // it reached. The bucket is created by `sharedRustFs` itself.
    `STORAGE_S3_ENDPOINT=http://${rustfs.getHost()}:${rustfs.getMappedPort(9000)}`,
    `STORAGE_S3_BUCKET=${RUSTFS_BUCKET}`,
    `STORAGE_S3_ACCESS_KEY_ID=${RUSTFS_ACCESS_KEY}`,
    `STORAGE_S3_SECRET_ACCESS_KEY=${RUSTFS_SECRET_KEY}`,
    // `order-api`'s `user` scheme verifies a real OIDC token against a real
    // JWKS, so a dev run without these would exit 78 on a `ConfigInvalid`
    // naming the first one it reached. `pnpm dev:token` mints what they accept.
    `HTTP_JWT_JWKS_URI=${jwksUri(jwks)}`,
    `HTTP_JWT_ISSUER=${DEV_ISSUER}`,
    `HTTP_JWT_AUDIENCE=${DEV_AUDIENCE}`,
    // The OpenID provider `sharedOry` started, and the key the browser session
    // is sealed with. `order-api`'s `session` scheme and its login answerer
    // bind these; `pnpm dev:login` mints the cookie they accept.
    `HTTP_OIDC_ISSUER=${ORY_ISSUER}`,
    `HTTP_OIDC_CLIENT_ID=${ORY_CLIENT_ID}`,
    `HTTP_OIDC_CLIENT_SECRET=${ORY_CLIENT_SECRET}`,
    `HTTP_OIDC_REDIRECT_URI=${ORY_REDIRECT_URI}`,
    `HTTP_SESSION_KEYS=${sessionKeys}`,
    "OUTBOX_TENANTS=0199a1e0-0000-7000-8000-000000000001",
    "LOG_LEVEL=debug",
    "",
  ].join("\n");

  await writeFile(envFile, env);

  process.stderr.write(`[dev:env] containers up, ory provisioned, .env.dev written\n`);
};

await main();
