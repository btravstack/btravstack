import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // The shared PostgreSQL server and the application's migrated database —
    // once for the whole repository, not once per workspace. Tests separate by
    // tenant, not by database.
    globalSetup: ["@btravstack/example-order-infrastructure/global-setup"],
    // The image pull dominates a cold run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
