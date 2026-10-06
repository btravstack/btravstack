import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The shared PostgreSQL server and the application's migrated database —
      // once for the whole repository, not once per workspace. Tests separate by
      // tenant, not by database.
      globalSetup: [
        "@btravstack/example-order-infrastructure/global-setup",
        // The shared Redis the customers slice reads through.
        "@btravstack/internal-test-infra/redis",
      ],
      // The image pull dominates a cold run.
      testTimeout: 30_000,
      hookTimeout: 120_000,
    },
  }),
);
