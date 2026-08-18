import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ORDERS_DATABASE,
  postgresUrl,
  sharedPostgres,
} from "@btravstack/internal-test-infra/containers";
import { withLock } from "@btravstack/internal-test-infra/lock";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a TypeScript module augmentation of vitest's own `ProvidedContext` must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __ORDERS_DATABASE_URL__: string;
  }
}

const run = promisify(execFile);
const workspace = fileURLToPath(new URL("../", import.meta.url));

/**
 * The vitest `globalSetup` every workspace that boots the example application
 * registers.
 *
 * Two things happen here and nowhere else. The shared PostgreSQL server comes
 * up — reused across the whole repository, so the four workspaces that need it
 * pay for one container rather than four. And the committed migrations are
 * applied to the application's database with **`prisma migrate deploy`**: the
 * literal command a deployment runs, rather than the hand-rolled loop that
 * applied the SQL statement by statement when this example was in-memory
 * SQLite. `_prisma_migrations` is what makes running it again a no-op, and
 * {@link withLock} is what stops two workspaces' runs racing to be the first.
 *
 * Nothing here truncates or drops anything. Tests do not share a database by
 * accident and then clean up after each other — they share it on purpose, and
 * each one works inside a **tenant of its own** (`src/test-fixtures.ts`), so
 * there is nothing to clean and no order they have to run in.
 */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const url = postgresUrl(await sharedPostgres(), ORDERS_DATABASE);

  await withLock("orders-migrate", () =>
    run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: workspace,
      env: { ...process.env, DATABASE_URL: url },
    }),
  );

  provide("__ORDERS_DATABASE_URL__", url);

  // The server is reused, so stopping it here would pull it out from under
  // whichever workspace's run is still going.
  return () => {};
};
