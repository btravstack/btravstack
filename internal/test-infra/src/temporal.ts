import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedTemporal } from "./containers.js";

/** The key `@btravstack/temporal-testing` declares; restated, since this workspace cannot depend on that one. */
declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __BTRAVSTACK_TEMPORAL_ADDRESS__: string;
  }
}

/**
 * The repository's stand-in for `@btravstack/temporal-testing`'s
 * `temporalServer`: the same image and inject key, so the published
 * `temporalEnvironment` fixture is what every Temporal spec here mints its
 * namespace with — but the server `pnpm dev` also runs, labelled and locked
 * with every other shared container here.
 */
export default async ({ provide }: TestProject): Promise<void> => {
  const temporal = await sharedTemporal();

  provide(
    "__BTRAVSTACK_TEMPORAL_ADDRESS__",
    `${temporal.getHost()}:${temporal.getMappedPort(7233)}`,
  );
};
