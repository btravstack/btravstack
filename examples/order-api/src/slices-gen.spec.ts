import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderSlicesGen } from "@btravstack/internal-slice-codegen";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("slices.gen.ts", () => {
  it("matches the generator's output byte for byte", () => {
    // GIVEN the committed generated file
    const committed = readFileSync(
      fileURLToPath(new URL("./slices.gen.ts", import.meta.url)),
      "utf8",
    );
    // WHEN the same generator entry point renders this workspace's slice tree
    const rendered = renderSlicesGen(fileURLToPath(new URL(".", import.meta.url)));
    // THEN they are identical — a stale committed file fails here, locally and in CI
    expect(rendered).toBeOkWith(committed);
  });
});
