/**
 * The compile-time half of this module: `OrderRepository`'s privacy — provided by
 * `AppModule` but never exported, so no importer can name it — mirroring the
 * sibling `di` examples' own `*.test-d.ts` convention. Type-checked by this
 * package's `test:types` script (`tsc --noEmit -p tsconfig.test-d.json`), never
 * executed: `vitest.config.ts`'s `include` only matches `*.spec.ts`.
 */
import { Module, type Context } from "@btravstack/di";
import { test } from "vitest";

import { AppModule, Logger, OrderRepository, PlaceOrder, Router } from "./app.js";

test("an importer sees Router, PlaceOrder and Logger, but not OrderRepository", () => {
  const ctx = null as unknown as Context<
    typeof AppModule extends Module<infer X, unknown, unknown> ? X : never
  >;
  ctx.get(Router);
  ctx.get(PlaceOrder);
  ctx.get(Logger);
  // @ts-expect-error OrderRepository is provided by AppModule but never exported, so no importer can name it
  ctx.get(OrderRepository);
});
