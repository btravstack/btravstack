import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { Cache } from "./cache.js";
import { memoryCache } from "./memory.js";
import { cache } from "./module.js";

describe("cache", () => {
  it("provides Cache from the adapter's backend when instrumentation is off", async () => {
    // GIVEN a graph composing the memory adapter, opted out of instrumentation
    // — the ONLY arm that needs no observability, which is what `false` buys
    const root = Module("Root")({
      imports: [cache({ adapter: memoryCache(), instrumented: false })],
      exports: [Cache],
    });

    // WHEN Cache is resolved and driven
    const read = await Module.scoped(root, (ctx) => {
      const service = ctx.get(Cache);
      return service.set("k", "v").flatMap(() => service.get("k"));
    });

    // THEN the port answers what the adapter stored
    expect(read).toBeOkWith({ value: "v" });
  });
});
