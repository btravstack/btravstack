import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

/**
 * Every `model` schema.prisma declares. PostgreSQL gets a table named after
 * the model unless `@@map` says otherwise, and nothing here uses `@@map`.
 */
const modelsInSchema = (): readonly string[] =>
  [
    ...readFileSync(
      fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
      "utf8",
    ).matchAll(/^model\s+(\w+)\s*\{/gm),
  ].map((match) => match[1] ?? "");

describe("the committed migrations", () => {
  it("creates a table for every model the schema declares", async ({ db }) => {
    // GIVEN the models `schema.prisma` declares — the source the generated
    // client's types are built from
    const models = modelsInSchema();
    expect(models.length).toBeGreaterThan(0);

    // WHEN the database `openDatabase` built is asked what it actually has
    const tables = await db.$queryRawUnsafe<readonly { readonly name: string }[]>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
    );

    // THEN every model has its table. The migrations are generated from this
    // schema, so the two agree by construction — what this pins is that they
    // were *regenerated*: editing the schema without running
    // `prisma migrate dev` leaves the client's types (which come from the
    // schema) describing a column no migration ever created, and nothing else
    // in the gate would notice until a query reached it.
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([...models]));
  });
});
