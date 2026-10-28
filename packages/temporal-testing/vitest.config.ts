import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The repository's one Temporal server, which this package's own
      // fixture registers a namespace on — see `internal/test-infra`.
      globalSetup: ["@btravstack/internal-test-infra/temporal"],
      testTimeout: 60_000,
      hookTimeout: 180_000,
      coverage: covered(),
    },
  }),
);
