import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { test } from "vitest";

import { DDL, type Database } from "./schema.js";

export const it = test.extend<{
  db: Kysely<Database>;
  seedOutbox: (count: number) => Promise<void>;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern
  db: async ({}, use) => {
    const pglite = new PGlite();
    await pglite.exec(DDL);
    const db = new Kysely<Database>({ dialect: new PGliteDialect(pglite) });
    await use(db);
    await db.destroy();
  },
  seedOutbox: async ({ db }, use) => {
    await use(async (count) => {
      await db
        .insertInto("outbox")
        .values(
          Array.from({ length: count }, (_, index) => ({
            id: crypto.randomUUID(),
            aggregate_id: crypto.randomUUID(),
            type: "TestEvent",
            payload: JSON.stringify({ sequence: index + 1 }),
          })),
        )
        .execute();
    });
  },
});
