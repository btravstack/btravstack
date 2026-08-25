import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // No container, and that is the point rather than an omission: a Prisma
    // client dials on the first statement, so the pool's lifecycle — which is
    // all this package owns — is provable against a stub client. A database
    // here would test Prisma, not this.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
