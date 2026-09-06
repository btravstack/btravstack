import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ORDERS_APP_PASSWORD,
  ORDERS_APP_USER,
  ORDERS_DATABASE,
  postgresUrl,
  provisionApplicationRole,
  sharedPostgres,
} from "@btravstack/internal-test-infra/containers";
import { withLock } from "@btravstack/internal-test-infra/lock";
import type {} from "vitest";
import type { TestProject } from "vitest/node";

/**
 * The key this setup provides, declared beside it.
 *
 * `import type {} from "vitest"` above is load-bearing: TypeScript can only
 * augment a module the program has already loaded, and nothing else here imports
 * vitest's root entry.
 */
declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __ORDERS_DATABASE_URL__: string;
    /**
     * The owner's URL — the role that migrates. No spec connects with it: it is
     * here so `rls.spec.ts` can be pointed at a superuser by hand and watched
     * to go red, which is the only way to tell a policy that holds from a
     * policy that was never reached.
     */
    __ORDERS_OWNER_DATABASE_URL__: string;
  }
}

const run = promisify(execFile);
const workspace = fileURLToPath(new URL("../", import.meta.url));

/**
 * The vitest `globalSetup` every workspace that boots the example application
 * registers: the shared PostgreSQL server comes up, and the committed migrations
 * are applied with **`prisma migrate deploy`** — the literal command a
 * deployment runs. `_prisma_migrations` makes running it again a no-op, and
 * {@link withLock} stops two workspaces' runs racing to be first.
 *
 * Nothing here truncates or drops anything: each test works inside a **tenant of
 * its own**, so there is nothing to clean and no order they must run in.
 *
 * The owner is what migrates; what the specs are given is the application
 * role's URL, because the owner is a superuser and a superuser bypasses row
 * security.
 */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const postgres = await sharedPostgres();
  const ownerUrl = postgresUrl(postgres, ORDERS_DATABASE);

  await withLock("orders-migrate", () =>
    run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: workspace,
      env: { ...process.env, DATABASE_URL: ownerUrl },
    }),
  );

  await provisionApplicationRole(postgres);

  provide("__ORDERS_OWNER_DATABASE_URL__", ownerUrl);

  provide(
    "__ORDERS_DATABASE_URL__",
    postgresUrl(postgres, ORDERS_DATABASE, {
      user: ORDERS_APP_USER,
      password: ORDERS_APP_PASSWORD,
    }),
  );

  // The server is reused, so stopping it here would pull it out from under
  // whichever workspace's run is still going.
  return () => {};
};
