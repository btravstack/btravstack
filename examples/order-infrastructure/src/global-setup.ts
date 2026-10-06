import { migrateOrders, sharedPostgres } from "@btravstack/internal-test-infra/containers";
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
  }
}

/**
 * The vitest `globalSetup` every workspace that boots the example application
 * registers: the shared PostgreSQL server comes up and {@link migrateOrders}
 * applies the committed migrations, answering the application role's URL.
 *
 * Nothing here truncates or drops anything: each test works inside a **tenant of
 * its own**, so there is nothing to clean and no order they must run in.
 */
export default async ({ provide }: TestProject): Promise<void> => {
  provide("__ORDERS_DATABASE_URL__", await migrateOrders(await sharedPostgres()));
};
