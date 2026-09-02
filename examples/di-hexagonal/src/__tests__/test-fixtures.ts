// Side-effect import: brings `@unthrown/vitest`'s `toBeOkWith`/`toBeErrTagged`
// module augmentation of vitest's `Assertion` into this compilation — `tsc`
// only sees an ambient augmentation once some file in the program imports the
// module that declares it. Runtime registration is separate (this package's
// `vitest.config.ts` `setupFiles`).
import "@unthrown/vitest";
import type { ScopedOptions } from "@btravstack/di";
import { test } from "vitest";

/**
 * A scope's teardown, recorded: `options` goes to `Module.scoped`, `errors()`
 * is what a spec asserts on. One object rather than two bindings, so nothing
 * reaches into an array somebody else owns.
 */
export type Teardown = {
  readonly options: ScopedOptions;
  readonly errors: () => readonly (readonly [string, unknown])[];
};

export type HexagonalFixtures = {
  readonly teardown: Teardown;
};

export const it = test.extend<HexagonalFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  teardown: async ({}, use) => {
    const seen: (readonly [string, unknown])[] = [];
    await use({
      options: { onTeardownError: (portId, cause) => void seen.push([portId, cause]) },
      errors: () => seen,
    });
  },
});
