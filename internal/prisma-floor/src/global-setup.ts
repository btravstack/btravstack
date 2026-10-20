import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  POSTGRES_USER,
  postgresUrl,
  sharedPostgres,
} from "@btravstack/internal-test-infra/containers";
import type {} from "vitest";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __PRISMA_FLOOR_OWNER_URL__: string;
    __PRISMA_FLOOR_APP_URL__: string;
  }
}

/**
 * A database of its own on the shared server, migrated by the floor train's
 * `prisma db migrate` from the history released under it, then a non-owner
 * role: the starter refuses to boot as one row security does not apply to.
 * A global setup rather than a fixture because a cold image pull and the CLI
 * outlast a test's timeout. Dropped on teardown, since a reused server
 * outlives the run.
 */
export default async ({ provide }: TestProject): Promise<() => Promise<void>> => {
  const server = await sharedPostgres();
  await psql(server, "postgres", [
    `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`,
    `CREATE DATABASE ${DATABASE}`,
  ]);
  const ownerUrl = postgresUrl(server, DATABASE);
  await prisma(ownerUrl, "db", "migrate");
  await psql(server, DATABASE, [
    `DO $$ BEGIN CREATE ROLE ${APP_USER} NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${APP_USER}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `GRANT USAGE ON SCHEMA orders TO ${APP_USER}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA orders TO ${APP_USER}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA orders TO ${APP_USER}`,
  ]);
  provide("__PRISMA_FLOOR_OWNER_URL__", ownerUrl);
  provide(
    "__PRISMA_FLOOR_APP_URL__",
    postgresUrl(server, DATABASE, { user: APP_USER, password: APP_USER }),
  );
  return () => psql(server, "postgres", [`DROP DATABASE ${DATABASE} WITH (FORCE)`]);
};

/**
 * Runs the floor CLI against `url` as a deployment does, and answers its
 * result. The CLI writes one JSON line per step and one for its result; a
 * failed command exits non-zero, which rejects here.
 */
export const prisma = async (url: string, ...command: readonly string[]): Promise<unknown> => {
  const { stdout } = await run("pnpm", ["exec", "prisma", ...command, "--json"], {
    cwd: workspace,
    env: { ...process.env, DATABASE_URL: url },
  });
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { kind: string; envelope?: { result?: unknown } })
    .find(({ kind }) => kind === "result")?.envelope?.result;
};

const DATABASE = "prisma_floor";
const APP_USER = "prisma_floor_app";
const workspace = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

const psql = async (
  server: Awaited<ReturnType<typeof sharedPostgres>>,
  database: string,
  statements: readonly string[],
): Promise<void> => {
  const { exitCode, output } = await server.exec([
    "psql",
    "-U",
    POSTGRES_USER,
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    ...statements.flatMap((statement) => ["-c", statement]),
  ]);
  if (exitCode !== 0)
    // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here
    throw new Error(`psql failed on '${database}': ${output}`);
};
