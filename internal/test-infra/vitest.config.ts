import { defineConfig } from "vitest/config";

// Its own config rather than the shared one, for `passWithNoTests`. This
// package has no specs today — the UUIDv7 helper it used to own went to the
// `uuidv7` package — but it holds real logic worth testing (`withLock`'s
// cross-process `mkdir` lock above all), so the slot stays rather than the
// `test` script being deleted along with the spec.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    passWithNoTests: true,
  },
});
