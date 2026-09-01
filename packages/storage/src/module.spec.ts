import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { aDocument, failingStorage, it } from "./__tests__/test-fixtures.js";
import { memoryStorage } from "./memory.js";
import { storage } from "./module.js";
import { Storage } from "./storage.js";

describe("storage", () => {
  it("provides Storage from the adapter's backend when instrumentation is off", async () => {
    // GIVEN a graph composing the memory adapter, opted out of instrumentation
    // — the only arm that needs no observability
    const root = Module("Root")({
      imports: [storage({ adapter: memoryStorage() })],
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

  it("declares a health check a reachable store answers", async () => {
    // GIVEN a graph over the in-memory adapter
    const root = Module("Root")({
      imports: [storage({ adapter: memoryStorage() })],
      exports: [Storage, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN a missing probe object is the store ANSWERING, so it is healthy
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "storage", status: "healthy" }],
    });
  });

  it("is healthy whether or not the probe object happens to exist", async () => {
    // GIVEN a store that DOES hold something at the probe key — the same
    // health answer as an empty store, by a different arm of the check
    const root = Module("Root")({
      imports: [storage({ adapter: memoryStorage() })],
      exports: [Storage, HealthChecks],
    });

    // WHEN the probe key is written and the contributed check is run
    const report = await Module.scoped(root, (ctx) =>
      ctx
        .get(Storage)
        .put("btravstack:health", new TextEncoder().encode("probe"), {
          contentType: "text/plain",
        })
        .flatMap(() => runHealthChecks(ctx.get(HealthChecks))),
    );

    // THEN it is healthy, because the store answered
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "storage", status: "healthy" }],
    });
  });

  it("reports storage unhealthy when the store cannot be reached", async () => {
    // GIVEN an adapter that reports every operation unavailable
    const root = Module("Root")({
      imports: [storage({ adapter: failingStorage() })],
      exports: [Storage, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the component is named and unhealthy, and the app with it
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [
        {
          name: "storage",
          status: "unhealthy",
          reason: expect.stringContaining("storage unavailable"),
        },
      ],
    });
  });
});
