import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // The one RustFS the whole gate shares. Tests separate by key prefix, not
    // by bucket or by server — a UUID under one bucket, needing no cleanup.
    globalSetup: ["@btravstack/internal-test-infra/rustfs"],
    // The image pull dominates a cold run.
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
