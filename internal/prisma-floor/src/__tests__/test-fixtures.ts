import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  POSTGRES_USER,
  postgresUrl,
  sharedPostgres,
} from "@btravstack/internal-test-infra/containers";
import { test } from "vitest";

export type Floor = {
  /** A role row security applies to, on a database the floor CLI migrated. */
  readonly url: string;
  /** Runs the floor CLI against that database as its owner, as a deployment does, and answers its result. */
  readonly prisma: (...command: readonly string[]) => Promise<unknown>;
};

/**
 * A database of its own on the shared server, migrated by the floor train's
 * `prisma db migrate` from the history released under it, then a non-owner
 * role: the starter refuses to boot as one row security does not apply to.
 * Dropped when the file is done, since a reused server outlives the run.
 */
export const it = test.extend<{ floor: Floor }>({
  floor: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
    async ({}, use) => {
      const server = await sharedPostgres();
      await psql(server, "postgres", [
        `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`,
        `CREATE DATABASE ${DATABASE}`,
      ]);
      const prisma = cli(postgresUrl(server, DATABASE));
      await prisma("db", "migrate");
      await psql(server, DATABASE, [
        `DO $$ BEGIN CREATE ROLE ${APP_USER} NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${APP_USER}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
        `GRANT USAGE ON SCHEMA orders TO ${APP_USER}`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA orders TO ${APP_USER}`,
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA orders TO ${APP_USER}`,
      ]);

      await use({
        url: postgresUrl(server, DATABASE, { user: APP_USER, password: APP_USER }),
        prisma,
      });

      await psql(server, "postgres", [`DROP DATABASE ${DATABASE} WITH (FORCE)`]);
    },
    { scope: "file" },
  ],
});

const DATABASE = "prisma_floor";
const APP_USER = "prisma_floor_app";
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const run = promisify(execFile);

// The CLI writes one JSON line per step and one for its result; a failed
// command exits non-zero, which rejects here.
const cli =
  (url: string) =>
  async (...command: readonly string[]): Promise<unknown> => {
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
    // oxlint-disable-next-line unthrown/no-throw -- a fixture reports a failed setup by rejecting; there is no Result channel here
    throw new Error(`psql failed on '${database}': ${output}`);
};
