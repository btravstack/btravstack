import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ORDERS_DATABASE,
  postgresUrl,
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
import { withLock } from "./lock.js";

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

/**
 * Brings up the six shared containers and writes the repository root's
 * `.env.dev` — what `turbo run dev` loads into each example process.
 *
 * The **same** containers the test suites use, attached to rather than
 * duplicated, so a warm machine pays nothing here and a `pnpm test` running
 * alongside shares them.
 *
 * The ports are therefore whatever Docker mapped, which is why the addresses are
 * written to a file rather than defaulted: an ephemeral mapped port cannot be a
 * default.
 */
const main = async (): Promise<void> => {
  const postgres = await sharedPostgres();
  const databaseUrl = postgresUrl(postgres, ORDERS_DATABASE);

  const [rabbitmq, temporal, redis, mailpit, rustfs] = await Promise.all([
    sharedRabbitMq(),
    sharedTemporal(postgres),
    sharedRedis(),
    sharedMailpit(),
    sharedRustFs(),
  ]);

  await withLock("orders-migrate", () =>
    run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: infrastructure,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    }),
  );

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
    "OUTBOX_TENANTS=0199a1e0-0000-7000-8000-000000000001",
    "LOG_LEVEL=debug",
    "",
  ].join("\n");

  await writeFile(envFile, env);

  process.stderr.write(`[dev:env] containers up, .env.dev written\n`);
};

await main();
