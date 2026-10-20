import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The shared PostgreSQL server, and the floor CLI's `db migrate` into a
      // database of this workspace's own.
      globalSetup: ["./src/global-setup.ts"],
      // `db verify` is a CLI run, and a cold one starts the toolchain.
      testTimeout: 60_000,
      // The image pull dominates a cold run.
      hookTimeout: 180_000,
    },
  }),
);
