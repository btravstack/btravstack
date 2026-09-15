import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // ONE Temporal server (and its PostgreSQL) for the whole repository,
      // reused across every workspace's run rather than a time-skipping test
      // server per vitest worker — see `internal/test-infra`. Each spec file
      // registers a namespace of its own on it.
      globalSetup: ["@btravstack/internal-test-infra/temporal"],
      // The image pull dominates a cold run.
      testTimeout: 60_000,
      hookTimeout: 180_000,
      coverage: covered("src/test-workflows.ts"),
    },
  }),
);
