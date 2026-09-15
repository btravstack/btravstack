import { defineConfig } from "vitest/config";

import { covered } from "../../vitest.shared.js";

// Not the shared config: it registers `@unthrown/vitest`, and this package
// depends on nothing — not even unthrown.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: covered(),
  },
});
