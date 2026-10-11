import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The one Hydra the gate shares; each test mints a client of its own.
      globalSetup: ["src/__tests__/ory-setup.ts"],
      // The image pulls and Hydra's migration dominate a cold run.
      hookTimeout: 180_000,
      testTimeout: 30_000,
      coverage: covered(),
    },
  }),
);
