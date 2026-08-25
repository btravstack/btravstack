import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // ONE Temporal server (and its PostgreSQL) for the whole repository,
    // reused across every workspace's run rather than a time-skipping test
    // server per vitest worker — see `internal/test-infra`. Each spec file
    // registers a namespace of its own on it.
    globalSetup: ["@btravstack/internal-test-infra/temporal"],
    // The image pull dominates a cold run.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/**/*.test-d.ts",
        "src/test-fixtures.ts",
        "src/test-workflows.ts",
      ],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
