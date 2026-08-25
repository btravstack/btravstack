import { defineConfig } from "vitest/config";

// The one vitest config every workspace without special needs re-exports.
// A workspace that needs more (coverage thresholds, globalSetup, a cache dir)
// writes its own config instead of extending this one — divergence should be
// visible in the workspace, not hidden in an override.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
  },
});
