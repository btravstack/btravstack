import { fromSchema } from "@unthrown/standard-schema";
import { test } from "vitest";
import { z } from "zod";

import { port, wholeNumber } from "./env.js";

/**
 * A deployment-shaped environment built from the shared fragments — one port,
 * one bounded count — so the seven cases are pinned against the fragments
 * themselves rather than against any one deployment's variables.
 */
const validate = fromSchema(z.object({ PORT: port(3000), CONCURRENCY: wholeNumber(1, 1, 64) }));

export type ConfigFixtures = {
  readonly read: typeof validate;
};

export const it = test.extend<ConfigFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  read: async ({}, use) => {
    await use(validate);
  },
});
