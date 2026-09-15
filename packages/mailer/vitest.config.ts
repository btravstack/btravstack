import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The one Mailpit the whole gate shares. Tests separate by recipient, not
      // by server: every send names a UUID localpart and asserts through the
      // API by that address.
      globalSetup: ["@btravstack/internal-test-infra/mailpit"],
      // The image pull dominates a cold run.
      hookTimeout: 120_000,
      coverage: covered(),
    },
  }),
);
