import { defineConfig } from "vitest/config";

// Its own config rather than the shared one, for the coverage gate — which is
// what `vitest.shared.ts` says a workspace needing more should do, so the
// divergence is visible here. Every other published package enforces the same
// floor; the container was the one exception, and being the package whose
// type-level behaviour is the product is not a reason for its RUNTIME to go
// unmeasured.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
