import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // ONE RabbitMQ container for the whole repository, reused across every
    // workspace's run rather than started per run — see
    // `internal/test-infra`. Each test still gets its own vhost from the `it`
    // extension, so isolation costs nothing per test.
    globalSetup: ["@btravstack/internal-test-infra/rabbitmq"],
    // The image pull dominates a cold run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
