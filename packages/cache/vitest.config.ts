import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The one Redis server the whole gate shares. Tests separate by key
      // prefix, not by server or by database index.
      globalSetup: ["@btravstack/internal-test-infra/redis"],
      // The image pull dominates a cold run.
      hookTimeout: 120_000,
      coverage: covered(),
    },
  }),
);
