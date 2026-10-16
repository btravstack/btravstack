import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import shared, { covered } from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    resolve: {
      alias: [
        {
          find: /^@btravstack\/http-server\/internal$/,
          replacement: fileURLToPath(new URL("../http-server/src/internal.ts", import.meta.url)),
        },
        {
          find: /^@btravstack\/http-server$/,
          replacement: fileURLToPath(new URL("../http-server/src/index.ts", import.meta.url)),
        },
      ],
    },
    test: {
      // Real listeners, and the SDK's own client against them, under turbo's concurrency.
      testTimeout: 30_000,
      coverage: covered(),
    },
  }),
);
