import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The one LocalStack the whole gate shares. Tests separate by KMS key,
      // each under a UUID alias, needing no cleanup.
      globalSetup: ["@btravstack/internal-test-infra/localstack"],
      // The AWS SDK's default credential chain, as a deployment's platform
      // would inject it; the emulator accepts any.
      env: { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
      // The image pull dominates a cold run.
      hookTimeout: 120_000,
      coverage: covered(),
    },
  }),
);
