import { defineConfig } from "vitest/config";

// The one vitest config every workspace re-exports or merges over. A workspace
// that needs more (a globalSetup, a timeout, an alias) states only that in its
// own `vitest.config.ts`, so the divergence is visible where it applies.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
  },
});

/**
 * The coverage floor every published package holds, stated once. `exclude`
 * names anything beyond the spec, type-test and test-artifact files — the list
 * used to be copied per package and shipped one entry short in one of them.
 *
 * **`branches` is the one that catches an untested decision.** 100% lines and
 * functions say every line RAN; they say nothing about an `else` nobody took,
 * and the packages holding the decisions worth testing are the ones where that
 * gap was widest — `@btravstack/http-server` sat at 91.79% branches, 42
 * untested arms, in the package that owns authentication, CSRF and redirects.
 *
 * **It is a RATCHET, and every number is the one that package measured.** `90`
 * is the default because eleven of the thirteen clear it; the two that do not
 * pass their own, with the arms named where they are set. A threshold is
 * raised by testing arms and is never lowered to fit code that regressed:
 * a number that moves down to accommodate its subject is a report, not a gate.
 */
export const covered = (
  options: { readonly branches?: number } = {},
  ...exclude: readonly string[]
) => ({
  provider: "v8" as const,
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/__tests__/**", ...exclude],
  thresholds: { lines: 100, functions: 100, branches: options.branches ?? 90 },
});
