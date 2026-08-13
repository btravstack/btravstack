import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // One RabbitMQ container per run, started before any spec and stopped
    // after the last. Each test gets its own vhost from the `it` extension,
    // so isolation costs nothing per test.
    globalSetup: ["@amqp-contract/testing/global-setup"],
    // The image pull dominates a cold run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/test-fixtures.ts"],
    },
  },
});
