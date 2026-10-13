import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedPostgres, sharedTemporal } from "./containers.js";

/** The key `@btravstack/temporal-worker/testing` declares; restated, since this workspace cannot depend on that one. */
declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __BTRAVSTACK_TEMPORAL_ADDRESS__: string;
  }
}

/**
 * The repository's stand-in for `@btravstack/temporal-worker/testing`'s
 * `temporalServer`: the same inject key, so the published
 * `temporalEnvironment` fixture is what every Temporal spec here mints its
 * namespace with — but a server shared across every workspace's run, on the
 * PostgreSQL the example application's database also lives on, behind the
 * cross-workspace reuse lock. Those three are this repository's, which is why
 * the published setup starts its own containers instead.
 */
export default async ({ provide }: TestProject): Promise<void> => {
  const temporal = await sharedTemporal(await sharedPostgres());

  provide(
    "__BTRAVSTACK_TEMPORAL_ADDRESS__",
    `${temporal.getHost()}:${temporal.getMappedPort(7233)}`,
  );
};
