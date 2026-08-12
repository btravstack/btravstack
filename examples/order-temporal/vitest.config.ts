import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // The generous ceiling is for one thing only: the first run on a machine
    // that has never downloaded the 64 MB time-skipping test server. Warm, the
    // whole file is a couple of seconds — see the README's timings.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
