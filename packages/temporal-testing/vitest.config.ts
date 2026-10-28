import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The repository's one Temporal server, which this package's own
      // fixture registers a namespace on — see `internal/test-infra` — then a
      // namespace registered for the whole run, outside any test.
      globalSetup: [
        "@btravstack/internal-test-infra/temporal",
        "./src/__tests__/run-namespace.setup.ts",
      ],
      testTimeout: 60_000,
      hookTimeout: 180_000,
      coverage: covered(),
    },
  }),
);
