/**
 * A hexagonal slice: an application layer that names its own ports and never
 * mentions an adapter, a persistence layer with a private connection pool and
 * a public repository, and a composition root generic enough to wire the same
 * application against a production adapter or an in-memory one. This is the
 * shape `@btravstack/di` is built for — see the package README for the same
 * walk-through with commentary, and `src/index.spec.ts` for both graphs built
 * and exercised end to end.
 */
import { Module, Port, Provider, type NeedsGate, type Scope, type ServiceOf } from "@btravstack/di";
import { Err, Ok, TaggedError, type AsyncResult, type Result } from "unthrown";

export class OrderNotFound extends TaggedError("OrderNotFound")<{ readonly id: string }> {}
export class ConfigError extends TaggedError("ConfigError")<{ readonly reason: string }> {}

export type Order = {
  readonly id: string;
  readonly total: number;
};

/* ── Ports: the application's boundary, named by the domain, never by an
   adapter — ──────────────────────────────────────────────────────────── */

export class Env extends Port("Env")<Record<string, string | undefined>> {}
export class AppConfig extends Port("AppConfig")<{ readonly dbUrl: string }> {}

/**
 * The connection pool: a real resource, acquired once and closed on teardown,
 * which is what routes any module providing it through `Module.scoped`.
 *
 * `export`ed so `index.test-d.ts` can name the CLASS and attempt `ctx.get(Pool)`
 * — what that pins is that the DI module below never lists it in `exports`, so
 * no built context can name it even though the runtime map holds it.
 */
export class Pool extends Port("Pool")<{
  readonly findById: (id: string) => Order | undefined;
  readonly close: () => void;
}> {}

export class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

export class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

/* ── Application: the use case depends on the port, never an adapter ───── */

export class GetOrderInteractor {
  private readonly orders: ServiceOf<OrderRepository>;
  // Parameter-property shorthand (`constructor(private readonly orders: …)`)
  // has no type-erasure-only meaning, so this repo's tsconfig rejects it; the
  // field is declared and assigned explicitly instead.
  constructor({ orders }: { readonly orders: ServiceOf<OrderRepository> }) {
    this.orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.orders.findById(id);
  }
}

/* ── Config: shared by every persistence adapter that needs one ────────── */

export const ConfigModule = Module("Config")({
  provides: [
    // A stand-in `Env`: a real one would read `process.env` and let an unset
    // variable surface as the `ConfigError` below.
    Provider(Env)({ value: { ORDER_API_DATABASE_URL: "postgres://localhost/orders" } }),
    Provider(AppConfig)(
      { env: Env },
      {
        make: ({ env }) =>
          env["ORDER_API_DATABASE_URL"] === undefined
            ? Err(new ConfigError({ reason: "ORDER_API_DATABASE_URL is unset" }))
            : Ok({ dbUrl: env["ORDER_API_DATABASE_URL"] }),
      },
    ),
  ],
  exports: [AppConfig],
});

/**
 * Stands in for a real driver: a handful of in-process rows, closable
 * exactly once. `config.dbUrl` is read but otherwise unused — a real adapter
 * would pass it straight to whatever client it opens.
 */
const openPool = ({
  config,
}: {
  readonly config: ServiceOf<AppConfig>;
}): Result<ServiceOf<Pool>, never> => {
  void config.dbUrl;
  const seed: readonly Order[] = [
    { id: "0199a1e0-0000-7000-8000-000000000001", total: 4_200 },
    { id: "0199a1e0-0000-7000-8000-000000000002", total: 1_500 },
  ];
  let closed = false;
  return Ok({
    findById: (id) => (closed ? undefined : seed.find((row) => row.id === id)),
    close: () => {
      closed = true;
    },
  });
};

/**
 * The production adapter. `Pool` is resourceful, so this module's `Needs`
 * carries `Scope` — which propagates through anything that imports it,
 * routing it (and `makeAppModule` below, once applied to it) through
 * `Module.scoped` at the composition root, never `Module.build`.
 */
export const makePersistenceModule = () =>
  Module("Persistence")({
    imports: [ConfigModule],
    provides: [
      Provider(Pool)(
        { config: AppConfig },
        {
          acquire: openPool,
          release: (pool) => pool.close(),
        },
      ),
      Provider(OrderRepository)(
        { pool: Pool },
        {
          sync: ({ pool }) => ({
            findById: (id) => {
              const row = pool.findById(id);
              return (row === undefined ? Err(new OrderNotFound({ id })) : Ok(row)).toAsync();
            },
          }),
        },
      ),
    ],
    // `Pool` never appears here. It is genuinely present in the built context's
    // flat runtime map; `exports` withholds the TYPE that would name it.
    exports: [OrderRepository],
  });

/**
 * The in-memory adapter: nothing to acquire, so nothing to release — this
 * module's `Needs` is `never`, same as its `E` (a `value` provider cannot
 * fail). `Module.build` accepts it directly.
 */
export const InMemoryPersistenceModule = Module("InMemoryPersistence")({
  provides: [
    Provider(OrderRepository)({
      value: { findById: (id) => Ok({ id, total: 99 }).toAsync() },
    }),
  ],
  exports: [OrderRepository],
});

/**
 * The composition seam: generic in the persistence module's own `E`/`Needs`,
 * so the same application module wires up unchanged against either adapter.
 * Only the entry point used to build it — `Module.build` for the in-memory
 * graph, `Module.scoped` for the resourceful one — differs, and the type
 * system forces the right one at the call site (see `src/index.test-d.ts`).
 */
export const makeAppModule = <E, N extends Scope>(persistence: Module<OrderRepository, E, N>) => {
  type Imports = readonly [Module<OrderRepository, E, N>];
  type Provides = readonly [ReturnType<typeof getOrder>];
  const getOrder = () =>
    Provider(GetOrder)({ orders: OrderRepository }, { class: GetOrderInteractor });
  // di's `needs` gate defers while `E` is a type parameter, so the cast
  // discharges it. Nothing is waved through: the parameter admits `Scope` and
  // nothing else, so an adapter owing a real port would be this module's to
  // declare.
  return Module("App")({
    imports: [persistence],
    provides: [getOrder()],
    exports: [GetOrder],
  } as {
    readonly imports: Imports;
    readonly provides: Provides;
    readonly exports: readonly [typeof GetOrder];
  } & NeedsGate<Imports, Provides, []>);
};
