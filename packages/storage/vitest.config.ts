import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The one RustFS the whole gate shares. Tests separate by key prefix, not
      // by bucket or by server — a UUID under one bucket, needing no cleanup.
      globalSetup: ["@btravstack/internal-test-infra/rustfs"],
      // The image pull dominates a cold run.
      hookTimeout: 120_000,
      coverage: covered(),
    },
  }),
);
