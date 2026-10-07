import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // PGlite initialises its WASM database per test while workspace suites run in parallel.
    hookTimeout: 60_000,
  },
});
