import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    // The image pull and two CLI runs dominate a cold run.
    test: { testTimeout: 30_000, hookTimeout: 180_000 },
  }),
);
