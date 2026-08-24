import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ORDERS_DATABASE,
  postgresUrl,
  sharedPostgres,
  sharedRabbitMq,
  sharedTemporal,
} from "./containers.js";
import { withLock } from "./lock.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * The one workspace this script knows by path. It owns the schema and the
 * `prisma` CLI, so applying the committed migrations has to happen there —
 * the same `prisma migrate deploy` under the same lock as its own vitest
 * `globalSetup`, because the dev loop and the gate share one database and
 * neither may assume it ran first.
 */
const infrastructure = fileURLToPath(
  new URL("../../../examples/order-infrastructure", import.meta.url),
);

/**
 * Brings up the three shared containers and writes the repository root's
 * `.env.dev` — what `turbo run dev` loads into each example process.
 *
 * These are the **same** containers the test suites use, attached to rather
 * than duplicated: `withReuse()` hashes the creation options, so a warm
 * machine pays nothing here and a `pnpm test` running alongside shares them.
 * That is the point — a second set of dev containers would be the per-workspace
 * duplication issue #52 removed, wearing a different hat.
 *
 * The ports are therefore whatever Docker mapped, which is why the addresses
 * are written to a file rather than defaulted in each application's config: an
 * ephemeral mapped port cannot be a default.
 */
const main = async (): Promise<void> => {
  const postgres = await sharedPostgres();
  const databaseUrl = postgresUrl(postgres, ORDERS_DATABASE);

  const [rabbitmq, temporal] = await Promise.all([sharedRabbitMq(), sharedTemporal(postgres)]);

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
    "OUTBOX_TENANTS=0199a1e0-0000-7000-8000-000000000001",
    "LOG_LEVEL=debug",
    "",
  ].join("\n");

  await writeFile(new URL(".env.dev", `file://${repoRoot}`), env);

  process.stderr.write(`[dev:env] containers up, .env.dev written\n`);
};

await main();
