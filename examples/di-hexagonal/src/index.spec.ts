import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import {
  GetOrder,
  InMemoryPersistenceModule,
  makeAppModule,
  makePersistenceModule,
} from "./index.js";

describe("the hexagonal composition", () => {
  it("resolves a use case through its ports and releases what it acquired", async ({
    teardown,
  }) => {
    // GIVEN the production graph — the application over the pooled adapter
    const app = makeAppModule(makePersistenceModule());

    // WHEN a use case is resolved and run inside a scope
    const outcome = await Module.scoped(
      app,
      (ctx) => ctx.get(GetOrder).execute("0199a1e0-0000-7000-8000-000000000001"),
      teardown.options,
    );

    // THEN the order came back through the ports AND the pool's `release` ran
    // cleanly — the second half is what proves the graph was torn down rather
    // than merely type-checked
    expect({ outcome, teardownErrors: teardown.errors() }).toEqual({
      outcome: expect.objectContaining({
        value: { id: "0199a1e0-0000-7000-8000-000000000001", total: 4_200 },
      }),
      teardownErrors: [],
    });
  });

  it("answers an unknown id as a modeled error, not an exception", async ({ teardown }) => {
    // GIVEN the same production graph
    const app = makeAppModule(makePersistenceModule());

    // WHEN a use case is asked for an id the pool does not carry
    const outcome = await Module.scoped(
      app,
      (ctx) => ctx.get(GetOrder).execute("does-not-exist"),
      teardown.options,
    );

    // THEN the miss is a value on the error channel, with the id it was asked for
    expect(outcome).toBeErrTagged("OrderNotFound", { id: "does-not-exist" });
  });

  it("builds the same application against the in-memory adapter, with no Scope", async () => {
    // GIVEN the application over the adapter that acquires nothing —
    // `makeAppModule`'s `Needs` collapses to `never` for this instantiation,
    // which is why `Module.build` takes it with no scope argument (swapping in
    // `makePersistenceModule()` here is a compile error: `index.test-d.ts`)
    const app = makeAppModule(InMemoryPersistenceModule);

    // WHEN it is built and the use case run
    const order = await Module.build(app).flatMap((ctx) => ctx.get(GetOrder).execute("anything"));

    // THEN the port answered from memory, and the swap cost the application nothing
    expect(order).toBeOkWith({ id: "anything", total: 99 });
  });
});
