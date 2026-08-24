import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedRedis } from "./containers.js";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_REDIS_URL__: string;
  }
}

/**
 * One URL, because that is the whole of what `redisCache()` reads out of the
 * environment.
 */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const redis = await sharedRedis();

  provide(
    "__TESTCONTAINERS_REDIS_URL__",
    `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
  );

  // Nothing to tear down: the container is reused, so stopping it here would
  // pull it out from under whichever workspace's run is still going.
  return () => {};
};
