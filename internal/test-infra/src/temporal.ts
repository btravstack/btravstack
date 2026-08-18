import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedPostgres, sharedTemporal } from "./containers.js";

/** The keys this setup provides — see `rabbitmq.ts` for why they live beside the setup that provides them. */
declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_TEMPORAL_IP__: string;
    __TESTCONTAINERS_TEMPORAL_PORT_7233__: number;
  }
}

/**
 * The two keys are `@temporal-contract/testing`'s own — its `/extension`
 * fixtures `inject` exactly these to build the server address — so both
 * Temporal workspaces reach one server through the extension they already
 * ship with.
 *
 * This replaces the time-skipping test server the two suites used to start
 * per vitest **worker**: a worker-scoped fixture meant one 64 MB local
 * server per spec file, three of them at once across the repository. What is
 * given up with it is the skippable clock; what is bought is a namespace per
 * spec file on one real server, which is the isolation those suites actually
 * needed — neither of them ever advanced time.
 */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const temporal = await sharedTemporal(await sharedPostgres());

  provide("__TESTCONTAINERS_TEMPORAL_IP__", temporal.getHost());
  provide("__TESTCONTAINERS_TEMPORAL_PORT_7233__", temporal.getMappedPort(7233));

  // Reused, so stopping it here would pull it out from under whichever
  // workspace's run is still going.
  return () => {};
};
