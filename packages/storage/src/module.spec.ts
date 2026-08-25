import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { memoryStorage } from "./memory.js";
import { storage } from "./module.js";
import { Storage } from "./storage.js";
import { aDocument, it } from "./test-fixtures.js";

describe("storage", () => {
  it("provides Storage from the adapter's backend when instrumentation is off", async () => {
    // GIVEN a graph composing the memory adapter, opted out of instrumentation
    // — the only arm that needs no observability
    const root = Module("Root")({
      imports: [storage({ adapter: memoryStorage(), instrumented: false })],
      exports: [Storage],
    });
    const document = aDocument();

    // WHEN Storage is resolved and driven
    const read = await Module.scoped(root, (ctx) => {
      const service = ctx.get(Storage);
      return service
        .put("a/b.json", document.bytes, { contentType: document.contentType })
        .flatMap(() => service.get("a/b.json"));
    });

    // THEN the port answers what the adapter stored
    expect(read).toBeOkWith({ bytes: document.bytes, contentType: "application/json" });
  });
});
