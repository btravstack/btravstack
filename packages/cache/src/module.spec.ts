import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { failingCache, it } from "./__tests__/test-fixtures.js";
import { Cache } from "./cache.js";
import { memoryCache } from "./memory.js";
import { cache } from "./module.js";

describe("cache", () => {
  it("provides Cache from the adapter's backend", async () => {
    // GIVEN a graph composing the memory adapter and no observability at all —
    // which the starter no longer asks for, since it reads a set port it
    // contributes its own no-op member to
    const root = Module("Root")({
      imports: [cache({ adapter: memoryCache() })],
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

  it("declares a health check that a reachable cache answers", async () => {
    // GIVEN a graph over the memory adapter
    const root = Module("Root")({
      imports: [cache({ adapter: memoryCache() })],
      exports: [Cache, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN a miss on the probe key is the cache WORKING, so it is healthy
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "cache", status: "healthy" }],
    });
  });

  it("reports the cache unhealthy when the backend cannot answer", async () => {
    // GIVEN an adapter that fails every operation
    const root = Module("Root")({
      imports: [cache({ adapter: failingCache() })],
      exports: [Cache, HealthChecks],
    });

    // WHEN the contributed check is run
    const report = await Module.scoped(root, (ctx) => runHealthChecks(ctx.get(HealthChecks)));

    // THEN the component is named and unhealthy, and the app with it
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [
        {
          name: "cache",
          status: "unhealthy",
          reason: expect.stringContaining("cache unavailable"),
        },
      ],
    });
  });
});
