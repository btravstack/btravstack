import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The shared PostgreSQL server, and `prisma db migrate` against the
      // application's database — once for the whole repository, not once per
      // workspace. Tests separate by tenant, not by database.
      globalSetup: ["./src/global-setup.ts"],
      // The image pull dominates a cold run.
      testTimeout: 30_000,
      hookTimeout: 120_000,
    },
  }),
);
