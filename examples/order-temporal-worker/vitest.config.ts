import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // ONE Temporal server (and its PostgreSQL) for the whole repository, and
    // the application's own migrated database on that same server — see
    // `internal/test-infra`. This file registers a namespace of its own, and
    // each test a tenant of its own.
    globalSetup: [
      "@btravstack/internal-test-infra/temporal",
      "@btravstack/example-order-infrastructure/global-setup",
    ],
    // The generous ceiling is for one thing only: the first run on a machine
    // that has never pulled the images. Warm, the whole file is a couple of
    // seconds — see the README's timings.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
