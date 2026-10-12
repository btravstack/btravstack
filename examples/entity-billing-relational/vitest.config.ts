import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // PGlite's cold WASM initialization can happen in hooks or fixtures while suites run in parallel.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
