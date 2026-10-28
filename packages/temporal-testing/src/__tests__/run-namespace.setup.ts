import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { temporalNamespace } from "../index.js";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    runNamespace: string;
  }
}

/** A `globalSetup` registering one namespace for the run, where Vitest's `inject` and `vi` do not exist. */
export default async (project: TestProject): Promise<void> => {
  const address = project.getProvidedContext().__BTRAVSTACK_TEMPORAL_ADDRESS__;
  project.provide("runNamespace", await temporalNamespace(address, "run"));
};
