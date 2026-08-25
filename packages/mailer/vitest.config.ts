import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // The one Mailpit the whole gate shares. Tests separate by recipient, not
    // by server: every send names a UUID localpart and asserts through the
    // API by that address.
    globalSetup: ["@btravstack/internal-test-infra/mailpit"],
    // The image pull dominates a cold run.
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/test-fixtures.ts"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
