import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Real listeners, and a JWKS key pair per spec file, under turbo's concurrency.
      testTimeout: 30_000,
      coverage: covered(),
    },
  }),
);
