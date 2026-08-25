import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { RUSTFS_ACCESS_KEY, RUSTFS_BUCKET, RUSTFS_SECRET_KEY, sharedRustFs } from "./containers.js";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_S3_ENDPOINT__: string;
    __TESTCONTAINERS_S3_BUCKET__: string;
    __TESTCONTAINERS_S3_ACCESS_KEY__: string;
    __TESTCONTAINERS_S3_SECRET_KEY__: string;
  }
}

/** The four values `s3Storage()` reads out of the environment, minus the region, which has a default. */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const rustfs = await sharedRustFs();

  provide(
    "__TESTCONTAINERS_S3_ENDPOINT__",
    `http://${rustfs.getHost()}:${rustfs.getMappedPort(9000)}`,
  );
  provide("__TESTCONTAINERS_S3_BUCKET__", RUSTFS_BUCKET);
  provide("__TESTCONTAINERS_S3_ACCESS_KEY__", RUSTFS_ACCESS_KEY);
  provide("__TESTCONTAINERS_S3_SECRET_KEY__", RUSTFS_SECRET_KEY);

  // Nothing to tear down: the container is reused, so stopping it here would
  // pull it out from under whichever workspace's run is still going.
  return () => {};
};
