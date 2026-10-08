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
          find: /^@btravstack\/http-server\/jwt$/,
          replacement: fileURLToPath(new URL("../http-server/src/jwt.ts", import.meta.url)),
        },
        {
          find: /^@btravstack\/http-server\/oidc$/,
          replacement: fileURLToPath(new URL("../http-server/src/oidc.ts", import.meta.url)),
        },
        {
          find: /^@btravstack\/http-server\/session$/,
          replacement: fileURLToPath(new URL("../http-server/src/session.ts", import.meta.url)),
        },
        {
          find: /^@btravstack\/http-server$/,
          replacement: fileURLToPath(new URL("../http-server/src/index.ts", import.meta.url)),
        },
      ],
    },
    test: {
      include: [
        "src/**/*.spec.ts",
        "../orpc-server/src/**/*.spec.ts",
        "../htmx-server/src/**/*.spec.ts",
        "../graphql-server/src/**/*.spec.ts",
      ],
      // Real listeners, and a JWKS key pair per spec file, under turbo's concurrency.
      testTimeout: 30_000,
      coverage: covered(),
    },
  }),
);
