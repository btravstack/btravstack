import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // The shared PostgreSQL server, and `prisma migrate deploy` against the
    // application's database — once for the whole repository, not once per
    // workspace. Tests separate by tenant, not by database.
    globalSetup: ["./src/global-setup.ts"],
    // The image pull dominates a cold run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
