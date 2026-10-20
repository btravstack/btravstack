import { inject, test } from "vitest";

import { prisma } from "../global-setup.js";

export type Floor = {
  /** A role row security applies to, on the database `src/global-setup.ts` migrated. */
  readonly url: string;
  /** Runs the floor CLI against that database as its owner, as a deployment does, and answers its result. */
  readonly prisma: (...command: readonly string[]) => Promise<unknown>;
};

export const it = test.extend<{ floor: Floor }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  floor: async ({}, use) => {
    const owner = inject("__PRISMA_FLOOR_OWNER_URL__");
    await use({
      url: inject("__PRISMA_FLOOR_APP_URL__"),
      prisma: (...command) => prisma(owner, ...command),
    });
  },
});
