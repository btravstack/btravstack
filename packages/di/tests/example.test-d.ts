import { test } from "vitest";

import { Module, Port, Provider, type Context } from "../src/index.js";

/**
 * The type-level half of the hexagonal example in `example.spec.ts`: an
 * importer of a module can only name what that module exports, even though
 * the built `Context` is flat and genuinely holds every internal port's
 * service too. Kept in its own `.test-d.ts` file, not a fourth `test()` in
 * `example.spec.ts`, because privacy is a *compile-time* guarantee — this
 * file's bodies are type-checked (`vitest.config.ts`'s `typecheck.include`)
 * but never executed, so `ctx` can be a `null` stand-in used only for its
 * type. A runtime `test()` executing `ctx.get(...)` against that same
 * `null` would throw, and asserting the port is runtime-absent would assert
 * something false — `exports` withholds the *type* that names a port, not
 * the entry in the map.
 */

class Database extends Port("YDatabase")<{ readonly rows: readonly unknown[] }> {}
class OrderRepository extends Port("YOrderRepository")<{
  readonly findById: () => string;
}> {}
class GetOrder extends Port("YGetOrder")<{ readonly execute: () => string }> {}

const Persistence = Module("YPersistence")({
  provides: [
    Provider(Database)({ value: { rows: [] } }),
    Provider(OrderRepository)({ db: Database }, { sync: () => ({ findById: () => "o-1" }) }),
  ],
  exports: [OrderRepository],
});

// `Needs = never`, not a generic `N`: importing a module that still owes
// something would make those needs this module's to declare, and a factory
// cannot name ports it has not been told about.
const makeAppModule = <E>(persistence: Module<OrderRepository, E, never>) =>
  Module("YApp")({
    imports: [persistence],
    provides: [
      Provider(GetOrder)(
        { orders: OrderRepository },
        {
          sync: ({ orders }) => ({ execute: () => orders.findById() }),
        },
      ),
    ],
    exports: [GetOrder],
  });

test("an importer sees only the exported surface in the built context's type", () => {
  const app = makeAppModule(Persistence);
  const ctx = null as unknown as Context<
    ReturnType<typeof makeAppModule> extends Module<infer X, unknown, unknown> ? X : never
  >;
  ctx.get(GetOrder);
  // @ts-expect-error Database is internal to Persistence
  ctx.get(Database);
  void app;
});
