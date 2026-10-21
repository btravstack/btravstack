import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedLocalStack } from "./containers.js";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_KMS_ENDPOINT__: string;
  }
}

/** The endpoint `kmsKeys()` is pointed at through `KEYS_KMS_ENDPOINT`. */
export default async ({ provide }: TestProject): Promise<void> => {
  const localstack = await sharedLocalStack();

  provide(
    "__TESTCONTAINERS_KMS_ENDPOINT__",
    `http://${localstack.getHost()}:${localstack.getMappedPort(4566)}`,
  );
};
