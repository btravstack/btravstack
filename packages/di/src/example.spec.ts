import { Err, Ok, OkAsync, TaggedError, fromNullable, type AsyncResult } from "unthrown";
import { expect, test } from "vitest";

import {
  Module,
  Port,
  Provider,
  type NeedsGate,
  type Scope,
  type ScopedOptions,
  type ServiceOf,
} from "./index.js";

/**
 * A worked hexagonal example: ports named by the application (`OrderRepository`,
 * `GetOrder`), two adapters bound at one edge (a resourceful "production"
 * persistence module and a resource-free in-memory one), and an application
 * module generic in the persistence module's own `E`/`Needs` so it can be built
 * against either without change. See the package README for the same walk-through
 * with commentary.
 */

class OrderNotFound extends TaggedError("XOrderNotFound")<{ readonly id: string }> {}
class ConfigError extends TaggedError("XConfigError")<{ readonly reason: string }> {}

type Order = {
  readonly id: string;
  readonly total: number;
};

// --- Ports: the application's boundary, named by the domain, not by any adapter. ---

class Env extends Port("XEnv")<Record<string, string | undefined>> {}
class AppConfig extends Port("XAppConfig")<{ readonly dbUrl: string }> {}
class Database extends Port("XDatabase")<{ readonly rows: readonly Order[] }> {}
class OrderRepository extends Port("XOrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
class GetOrder extends Port("XGetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

// --- Application: the use case, depending only on the port, never an adapter. ---

class GetOrderInteractor {
  private readonly orders: ServiceOf<OrderRepository>;
  // `erasableSyntaxOnly` (this repo's tsconfig) rejects TypeScript's parameter-property
  // shorthand — `constructor(private readonly orders: ...)` — since it has no
  // type-erasure-only meaning; the field is declared and assigned explicitly instead.
  constructor({ orders }: { readonly orders: ServiceOf<OrderRepository> }) {
    this.orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.orders.findById(id);
  }
}

const ConfigModule = Module("Config")({
  provides: [
    Provider(Env)({ value: { XDATABASE_URL: "postgres://localhost/app" } }),
    Provider(AppConfig)(
      { env: Env },
      {
        make: ({ env }) =>
          env["XDATABASE_URL"] === undefined
            ? Err(new ConfigError({ reason: "XDATABASE_URL is unset" }))
            : Ok({ dbUrl: env["XDATABASE_URL"] }),
      },
    ),
  ],
  exports: [AppConfig],
});

/**
 * The production adapter. `Database` opens a real connection and must close
 * it again, so its provider is the resourceful `acquire`/`release` arm — which
 * puts `Scope` in this module's `Needs` (see `provider.ts`'s `ScopeOf`) and so
 * routes the whole graph through `Module.scoped`, not `Module.build`, at the
 * composition root below. `released` is the test's own hook into that
 * teardown, not part of the shape a real adapter would have.
 */
const makePersistenceModule = (released: string[]) =>
  Module("Persistence")({
    imports: [ConfigModule],
    provides: [
      Provider(Database)(
        { config: AppConfig },
        {
          acquire: () => Ok({ rows: [{ id: "o-1", total: 10 }] }),
          release: () => void released.push("database"),
        },
      ),
      Provider(OrderRepository)(
        { db: Database },
        {
          sync: ({ db }) => ({
            findById: (id) => {
              const row = db.rows.find((r) => r.id === id);
              return fromNullable(row, () => new OrderNotFound({ id })).toAsync();
            },
          }),
        },
      ),
    ],
    exports: [OrderRepository],
  });

/**
 * The in-memory adapter: no connection, so no resource, so no `Scope` — its
 * `Needs` is `never`, same as its `E` (a `value` provider cannot fail).
 */
const InMemoryPersistenceModule = Module("InMemoryPersistence")({
  provides: [
    Provider(OrderRepository)({
      value: { findById: (id) => OkAsync({ id, total: 99 }) },
    }),
  ],
  exports: [OrderRepository],
});

/**
 * The composition seam: generic in the persistence module's own `E`/`Needs`,
 * so the same application module wires up unchanged against either adapter —
 * only the entry point used to build it (`Module.build` vs `Module.scoped`)
 * differs, and that difference is forced by the type system, not a choice.
 */
// `N extends Scope`, not a free `N`: the two adapters differ in whether their
// provider is resourceful, and nothing else. A persistence module that owed a
// real port would be this module's to declare, and a seam generic over that
// cannot name what it would have to declare.
const makeAppModule = <E, N extends Scope>(persistence: Module<OrderRepository, E, N>) => {
  type Imports = readonly [Module<OrderRepository, E, N>];
  type Provides = readonly [ReturnType<typeof getOrderProvider>];
  const getOrderProvider = () =>
    Provider(GetOrder)({ orders: OrderRepository }, { class: GetOrderInteractor });
  // The discharged-signature cast `runMain` makes around `start`'s gate, for
  // the same reason: `NeedsGate` cannot be computed while `I` is still a type
  // parameter, so it defers and no object literal satisfies it. The gate is
  // this seam's caller's to pass — here the imported module's needs are
  // `Scope` at most, which the gate exempts anyway.
  return Module("App")({
    imports: [persistence],
    provides: [getOrderProvider()],
    exports: [GetOrder],
  } as {
    readonly imports: Imports;
    readonly provides: Provides;
    readonly exports: readonly [typeof GetOrder];
  } & NeedsGate<Imports, Provides, []>);
};

test("the production graph resolves a use case through its ports, and releases what it acquired", async () => {
  const released: string[] = [];
  const teardownErrors: (readonly [string, unknown])[] = [];
  const options: ScopedOptions = {
    onTeardownError: (portId, cause) => void teardownErrors.push([portId, cause]),
  };

  const outcome = await Module.scoped(
    makeAppModule(makePersistenceModule(released)),
    (ctx) => ctx.get(GetOrder).execute("o-1"),
    options,
  );

  expect(outcome).toBeOkWith({ id: "o-1", total: 10 });
  // The `Database` connection opened by `acquire` was closed by `release`
  // once `use` settled — proof the resourceful arm's teardown actually ran,
  // not just that it type-checked.
  expect(released).toEqual(["database"]);
  expect(teardownErrors).toEqual([]);
});

test("the same app module builds against an in-memory adapter, with no Scope required", async () => {
  // `Module.build` — not `.scoped` — is the point: `InMemoryPersistenceModule`
  // has no resourceful provider, so `makeAppModule`'s `Needs` collapses to
  // `never` for this instantiation, and `Module.build`'s compile-time gate
  // (Task 5) accepts it with no extra argument. Swapping in
  // `makePersistenceModule` here — the resourceful adapter — is a compile
  // error, not a runtime surprise: its `Needs` is `Scope`, which only
  // `Module.scoped` discharges.
  const built = await Module.build(makeAppModule(InMemoryPersistenceModule));
  expect(built).toBeOk();
  const order = built.isOk() ? await built.value.get(GetOrder).execute("anything") : undefined;
  expect(order).toBeOkWith({ id: "anything", total: 99 });
});

// The third guarantee this example proves — an importer sees only the exported
// surface in the built context's *type* — is compile-time only (see
// `example.test-d.ts`): the context is flat, so `Database` really is in the
// runtime map, and asserting its absence at runtime would assert something
// false. `vitest`'s `include`/`typecheck.include` split (`vitest.config.ts`)
// is exactly what keeps that assertion from ever executing — `.test-d.ts`
// files are type-checked, never run — which is why it lives in its own file
// rather than as a fourth `test()` here.
