import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

/**
 * Every `model` schema.prisma declares. SQLite names the table after the model
 * unless `@@map` says otherwise, and nothing here uses `@@map`.
 */
const modelsInSchema = (): readonly string[] =>
  [
    ...readFileSync(
      fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
      "utf8",
    ).matchAll(/^model\s+(\w+)\s*\{/gm),
  ].map((match) => match[1] ?? "");

describe("the hand-written DDL", () => {
  it("creates a table for every model the schema declares", async ({ db }) => {
    // GIVEN the models `schema.prisma` declares — the source the generated
    // client's types are built from
    const models = modelsInSchema();
    expect(models.length).toBeGreaterThan(0);

    // WHEN the database `openDatabase` built is asked what it actually has
    const tables = await db.$queryRawUnsafe<readonly { readonly name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );

    // THEN every model has its table. `openDatabase`'s `DDL` and the schema
    // are two sources of truth for one shape — this is what stops them
    // drifting, because a model added to the schema alone still *compiles*
    // (the client's types come from the schema) and only fails when a query
    // reaches the missing table at runtime.
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([...models]));
  });
});
