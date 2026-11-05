import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { prismaDatabase } from "@btravstack/prisma";
import postgres from "@prisma/orm-postgres/runtime";
import { fromSafePromise } from "unthrown";
import { inject, test } from "vitest";

import { prisma } from "../global-setup.js";
import type { Contract } from "../prisma/contract.js";
import contractJson from "../prisma/contract.json" with { type: "json" };

export type Floor = {
  /** A role row security applies to, on the database `src/global-setup.ts` migrated. */
  readonly url: string;
  /** Runs the floor CLI against that database as its owner, as a deployment does, and answers its result. */
  readonly prisma: (...command: readonly string[]) => Promise<unknown>;
};

export const it = test.extend<{ floor: Floor; db: ReturnType<typeof postgres<Contract>> }>({
  db: async ({ floor }, use) => {
    const database = prismaDatabase("FloorSnapshotDatabase")({
      client: ({ url, middleware }) => postgres<Contract>({ contractJson, url, middleware }),
    });
    const root = Module("FloorSnapshotRoot")({
      imports: [database],
      provides: [Provider(Env)({ inject: {}, value: { DATABASE_URL: floor.url } })],
      exports: [database.port],
    });
    (await Module.scoped(root, (ctx) => fromSafePromise(use(ctx.get(database.port))))).getOrThrow();
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  floor: async ({}, use) => {
    const owner = inject("__PRISMA_FLOOR_OWNER_URL__");
    await use({
      url: inject("__PRISMA_FLOOR_APP_URL__"),
      prisma: (...command) => prisma(owner, ...command),
    });
  },
});
