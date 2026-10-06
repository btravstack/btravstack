import { defineConfig, mergeConfig } from "vitest/config";

import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // ONE RabbitMQ container for the whole repository, reused across every
      // workspace's run rather than started per run — see
      // `internal/test-infra`. Each test still gets its own vhost from the `it`
      // extension, so isolation costs nothing per test.
      globalSetup: [
        "@btravstack/internal-test-infra/rabbitmq",
        // The shared Mailpit the notifications slice sends through, and the
        // shared RustFS its invoices are stored in.
        "@btravstack/internal-test-infra/mailpit",
        "@btravstack/internal-test-infra/rustfs",
        "@btravstack/example-order-infrastructure/global-setup",
      ],
      // The image pull dominates a cold run.
      testTimeout: 30_000,
      hookTimeout: 120_000,
    },
  }),
);
