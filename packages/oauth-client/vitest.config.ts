import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Shared issuers; tests own a Hydra client or a Keycloak realm.
      globalSetup: ["src/__tests__/ory-setup.ts"],
      // Image pulls, Hydra migration and Keycloak rebuild dominate cold setup.
      hookTimeout: 180_000,
      testTimeout: 30_000,
      coverage: covered(),
    },
  }),
);
