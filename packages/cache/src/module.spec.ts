import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { Cache } from "./cache.js";
import { memoryCache } from "./memory.js";
import { cache } from "./module.js";
import { it } from "./test-fixtures.js";

describe("cache", () => {
  it("provides Cache from the adapter's backend", async () => {
    // GIVEN a graph composing the memory adapter
    const root = Module("Root")({ imports: [cache({ adapter: memoryCache() })], exports: [Cache] });

    // WHEN Cache is resolved and driven
    const read = await Module.scoped(root, (ctx) => {
      const service = ctx.get(Cache);
      return service.set("k", "v").flatMap(() => service.get("k"));
    });

    // THEN the port answers what the adapter stored
    expect(read).toBeOkWith({ value: "v" });
  });
});
