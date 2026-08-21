import { describe, expect, it } from "vitest";
import { z } from "zod";

import { uuidv7 } from "./uuid.js";

describe("uuidv7", () => {
  it("mints valid, distinct v7 ids", () => {
    // GIVEN a schema that accepts only UUIDv7
    const schema = z.uuidv7();

    // WHEN a thousand are minted
    const minted = Array.from({ length: 1000 }, uuidv7);

    // THEN every one parses, and no two collide
    expect({
      allValid: minted.every((id) => schema.safeParse(id).success),
      distinct: new Set(minted).size,
    }).toEqual({ allValid: true, distinct: 1000 });
  });
});
