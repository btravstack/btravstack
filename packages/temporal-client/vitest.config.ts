import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // The repository's one Temporal server and its TLS proxy — see
      // `internal/test-infra`. The security specs connect through the proxy to
      // a namespace of their own.
      globalSetup: [
        "@btravstack/internal-test-infra/temporal",
        "@btravstack/internal-test-infra/temporal-tls",
      ],
      testTimeout: 60_000,
      hookTimeout: 180_000,
      coverage: covered(),
    },
  }),
);
