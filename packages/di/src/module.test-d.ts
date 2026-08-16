import { Err, Ok, TaggedError } from "unthrown";
import { describe, test } from "vitest";

import { Module, Port, Provider } from "./index.js";
import { type Equal } from "./type-assert.js";

class ConfigError extends TaggedError("MConfigError")<{ readonly reason: string }> {}
class PoolError extends TaggedError("MPoolError")<{ readonly url: string }> {}

class Env extends Port("MEnv")<Record<string, string | undefined>> {}
class AppConfig extends Port("MAppConfig")<{ readonly dbUrl: string }> {}
class Database extends Port("MDatabase")<{ readonly query: () => readonly unknown[] }> {}
class OrderRepository extends Port("MOrderRepository")<{ readonly find: () => string }> {}

const EnvProvider = Provider(Env)({ value: {} });
const AppConfigProvider = Provider(AppConfig)([Env], {
  make: (env) =>
    env["DATABASE_URL"] === undefined
      ? Err(new ConfigError({ reason: "unset" }))
      : Ok({ dbUrl: env["DATABASE_URL"] }),
});
const DatabaseProvider = Provider(Database)([AppConfig], {
  make: (cfg) =>
    cfg.dbUrl === "" ? Err(new PoolError({ url: cfg.dbUrl })) : Ok({ query: () => [] }),
});
const OrderRepositoryProvider = Provider(OrderRepository)([Database], {
  sync: (db) => ({ find: () => String(db.query().length) }),
});

const ConfigModule = Module("Config")({
  provides: [EnvProvider, AppConfigProvider],
  exports: [AppConfig],
});

/**
 * Recovers `Module`'s three type arguments by direct positional inference
 * against the same generic interface, rather than by assignability. `Exports`
 * sits in a contravariant field position and `E`/`Needs` in covariant ones, so a
 * plain `const typed: Module<X, E, N> = m` assignment proves only that each
 * channel is assignable in its own direction — never that it is the channel the
 * value actually carries. See `provider.test-d.ts`'s `ChannelsOf` for the same
 * pattern.
 */
type ChannelsOf<T> = T extends Module<infer X, infer E, infer N> ? readonly [X, E, N] : never;

describe("Module algebra", () => {
  test("Needs is empty when every requirement is provided internally", () => {
    const typed: Module<AppConfig, ConfigError, never> = ConfigModule;
    void typed;

    type Channels = ChannelsOf<typeof ConfigModule>;
    const exportsIsAppConfig: Equal<Channels[0], AppConfig> = true;
    const errorIsConfigError: Equal<Channels[1], ConfigError> = true;
    const errorIsNotUnknown: Equal<Channels[1], unknown> = false;
    const needsIsNever: Equal<Channels[2], never> = true;
    void exportsIsAppConfig;
    void errorIsConfigError;
    void errorIsNotUnknown;
    void needsIsNever;
  });

  test("E is the union of provider errors", () => {
    const persistence = Module("Persistence")({
      imports: [ConfigModule],
      provides: [DatabaseProvider, OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    const typed: Module<OrderRepository, ConfigError | PoolError, never> = persistence;
    void typed;

    type Channels = ChannelsOf<typeof persistence>;
    const exportsIsOrderRepository: Equal<Channels[0], OrderRepository> = true;
    const errorIsUnion: Equal<Channels[1], ConfigError | PoolError> = true;
    const errorIsNotUnknown: Equal<Channels[1], unknown> = false;
    const needsIsNever: Equal<Channels[2], never> = true;
    void exportsIsOrderRepository;
    void errorIsUnion;
    void errorIsNotUnknown;
    void needsIsNever;
  });

  test("E is not narrowable to one arm", () => {
    const persistence = Module("Persistence")({
      imports: [ConfigModule],
      provides: [DatabaseProvider, OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    // @ts-expect-error ConfigError is still in the union
    const typed: Module<OrderRepository, PoolError, never> = persistence;
    void typed;
  });

  test("an unmet requirement stays in Needs", () => {
    const orphan = Module("Orphan")({
      provides: [OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    const typed: Module<OrderRepository, never, Database> = orphan;
    void typed;

    type Channels = ChannelsOf<typeof orphan>;
    const exportsIsOrderRepository: Equal<Channels[0], OrderRepository> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    const needsIsDatabase: Equal<Channels[2], Database> = true;
    const needsIsNotNever: Equal<Channels[2], never> = false;
    void exportsIsOrderRepository;
    void errorIsNever;
    void needsIsDatabase;
    void needsIsNotNever;
  });

  test("an unmet requirement cannot be laundered to no requirement", () => {
    const orphan = Module("Orphan")({
      provides: [OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    // `orphan` genuinely needs `Database` (unmet — nothing provides or
    // imports it). `_needs` must be covariant so this widening lie is
    // rejected: if it were contravariant (as it read before this fix),
    // `Module<OrderRepository, never, Database>` would be assignable to
    // `Module<OrderRepository, never, never>` — laundering a real, unmet
    // dependency past a caller that asks for `Needs = never`, which is
    // exactly what Task 5's build gate uses to decide a module is
    // runnable. Pins the direction, not just the value, so a future
    // variance regression on `_needs` fails this test immediately instead
    // of surviving to a runtime "dependency missing" failure.
    // @ts-expect-error Database is still an unmet requirement
    const typed: Module<OrderRepository, never, never> = orphan;
    void typed;
  });

  test("a wider error union cannot be narrowed away", () => {
    const persistence = Module("Persistence")({
      imports: [ConfigModule],
      provides: [DatabaseProvider, OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    // Mirror control for the `_needs` test above, on the `_error` channel:
    // `persistence` can genuinely fail with `ConfigError | PoolError`, so a
    // caller declaring it as `Module<_, PoolError, _>` (dropping
    // `ConfigError`) must be rejected. This is the same assignment the
    // brief's "E is not narrowable to one arm" test already makes, kept
    // here as its own named test so the `_error`/`_needs` symmetry is
    // explicit and each variance choice has a test that fails immediately
    // if that field's direction ever regresses.
    // @ts-expect-error ConfigError is still a possible failure, not just PoolError
    const typed: Module<OrderRepository, PoolError, never> = persistence;
    void typed;
  });

  test("exporting a port the module neither provides nor imports is rejected", () => {
    Module("Bad")({
      provides: [EnvProvider],
      // @ts-expect-error AppConfig is neither provided nor imported here
      exports: [AppConfig],
    });
  });

  test("re-exporting a module that is not imported is rejected", () => {
    Module("Bad")({
      provides: [EnvProvider],
      // @ts-expect-error ConfigModule is not in imports
      exports: [ConfigModule],
    });
  });

  test("re-exporting an imported module widens Exports to its exports", () => {
    const facade = Module("Facade")({
      imports: [ConfigModule],
      exports: [ConfigModule],
    });
    const typed: Module<AppConfig, ConfigError, never> = facade;
    void typed;

    type Channels = ChannelsOf<typeof facade>;
    const exportsIsAppConfig: Equal<Channels[0], AppConfig> = true;
    const errorIsConfigError: Equal<Channels[1], ConfigError> = true;
    const needsIsNever: Equal<Channels[2], never> = true;
    void exportsIsAppConfig;
    void errorIsConfigError;
    void needsIsNever;
  });

  test("exporting a provider yields the same Exports channel as exporting its port", () => {
    const viaProvider = Module("Config")({
      provides: [EnvProvider, AppConfigProvider],
      exports: [AppConfigProvider],
    });
    const typed: Module<AppConfig, ConfigError, never> = viaProvider;
    void typed;

    type Channels = ChannelsOf<typeof viaProvider>;
    const exportsIsAppConfig: Equal<Channels[0], AppConfig> = true;
    const exportsMatchThePortForm: Equal<Channels[0], ChannelsOf<typeof ConfigModule>[0]> = true;
    void exportsIsAppConfig;
    void exportsMatchThePortForm;
  });

  test("exporting a provider for a port the module does not have is rejected", () => {
    Module("Bad")({
      provides: [EnvProvider],
      // @ts-expect-error AppConfigProvider's port is neither provided nor imported here
      exports: [AppConfigProvider],
    });
  });

  test("exporting something that is neither a port nor a provider is rejected", () => {
    Module("Bad")({
      provides: [EnvProvider],
      // @ts-expect-error a port id is not an export entry
      exports: ["MEnv"],
    });
  });

  test("an internal port is not in Exports", () => {
    const persistence = Module("Persistence")({
      imports: [ConfigModule],
      provides: [DatabaseProvider, OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    // @ts-expect-error Database is internal to Persistence
    const typed: Module<OrderRepository | Database, ConfigError | PoolError, never> = persistence;
    void typed;

    type Channels = ChannelsOf<typeof persistence>;
    const exportsIsNotUnionWithDatabase: Equal<Channels[0], OrderRepository | Database> = false;
    void exportsIsNotUnionWithDatabase;
  });
});
