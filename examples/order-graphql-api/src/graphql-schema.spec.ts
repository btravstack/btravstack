import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { expect } from "vitest";

import { it } from "./test-fixtures.js";

it("keeps the client-consumable SDL in sync with the Pothos schema", () => {
  // GIVEN a code-first schema and its checked-in contract artifact
  const sdl = readFileSync(
    new URL("../../order-graphql-contract/schema.graphql", import.meta.url),
    "utf8",
  );

  // WHEN the current schema is printed
  // THEN clients receive the same wire contract the server runs
  // Pothos and Vitest can load GraphQL into different module realms; the
  // separate process is the same path `graphql:schema` uses to print the SDL.
  const printed = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/print-graphql-schema.ts"],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    },
  );
  expect(sdl).toBe(printed);
}, 30_000);
