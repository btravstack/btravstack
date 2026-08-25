import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The specs use `@btravstack/testing`, which peers on THIS package. It is
  // not a devDependency — that would be a package-graph cycle turbo refuses —
  // so it is reached at its source here (and in `tsconfig.json`'s `paths` for
  // the type checker), and its own `@btravstack/core` imports are pointed back
  // at this `src`: one kernel in play, and coverage measures what the specs run.
  resolve: {
    alias: {
      "@btravstack/testing": fileURLToPath(new URL("../testing/src/index.ts", import.meta.url)),
      "@btravstack/core": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
