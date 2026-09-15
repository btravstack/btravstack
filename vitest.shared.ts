import { defineConfig } from "vitest/config";

// The one vitest config every workspace re-exports or merges over. A workspace
// that needs more (a globalSetup, a timeout, an alias) states only that in its
// own `vitest.config.ts`, so the divergence is visible where it applies.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
  },
});

/**
 * The coverage floor every published package holds, stated once. `exclude`
 * names anything beyond the spec, type-test and test-artifact files — the list
 * used to be copied per package and shipped one entry short in one of them.
 */
export const covered = (...exclude: readonly string[]) => ({
  provider: "v8" as const,
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**", ...exclude],
  thresholds: { lines: 100, functions: 100 },
});
