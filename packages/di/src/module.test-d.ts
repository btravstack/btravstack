import { Err, Ok, TaggedError } from "unthrown";
import { describe, test } from "vitest";

import { type Equal } from "./__tests__/type-assert.js";
import { Module, Port, Provider } from "./index.js";

class ConfigError extends TaggedError("MConfigError")<{ readonly reason: string }> {}
class PoolError extends TaggedError("MPoolError")<{ readonly url: string }> {}

class Env extends Port("MEnv")<Record<string, string | undefined>> {}
class AppConfig extends Port("MAppConfig")<{ readonly dbUrl: string }> {}
class Database extends Port("MDatabase")<{ readonly query: () => readonly unknown[] }> {}
class OrderRepository extends Port("MOrderRepository")<{ readonly find: () => string }> {}

const EnvProvider = Provider(Env)({ inject: {}, value: {} });
const AppConfigProvider = Provider(AppConfig)({
  inject: { env: Env },
  make: ({ env }) =>
    env["DATABASE_URL"] === undefined
      ? Err(new ConfigError({ reason: "unset" }))
      : Ok({ dbUrl: env["DATABASE_URL"] }),
});
const DatabaseProvider = Provider(Database)({
  inject: { config: AppConfig },
  make: ({ config }) =>
    config.dbUrl === "" ? Err(new PoolError({ url: config.dbUrl })) : Ok({ query: () => [] }),
});
const OrderRepositoryProvider = Provider(OrderRepository)({
  inject: { db: Database },
  sync: ({ db }) => ({ find: () => String(db.query().length) }),
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

  test("a declared requirement stays in Needs", () => {
    const orphan = Module("Orphan")({
      needs: [Database],
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

  test("only an import's own exports discharge a need", () => {
    // The rule the module algebra states about visibility, and the one the
    // root `CLAUDE.md`'s slices rest on: `Needs` subtracts `Available` —
    // what this module provides, plus what its imports EXPORT — and nothing
    // else. `Holder` imports the module that exports `AppConfig` and
    // re-exports nothing, so `AppConfig` is available inside `Holder` and
    // nowhere else; a sibling in the same tree still owes it. Pinned because
    // "a need bubbles up" reads as "a provider sees whatever the tree
    // happens to hold", and that is not what this is: the flat runtime graph
    // would resolve `AppConfig` here, and the type channel is what refuses
    // to.
    const Holder = Module("Holder")({ imports: [ConfigModule] });
    const opaque = Module("Opaque")({
      // Declared, because it genuinely still owes it: `Holder` re-exports
      // nothing, so importing it discharges nothing either.
      needs: [AppConfig],
      imports: [Holder],
      provides: [DatabaseProvider],
      exports: [Database],
    });
    type OpaqueChannels = ChannelsOf<typeof opaque>;
    const stillNeedsAppConfig: Equal<OpaqueChannels[2], AppConfig> = true;
    void stillNeedsAppConfig;

    // The same tree with the one difference that matters: `Holder` passes
    // the export on, and the need is discharged.
    const Passthrough = Module("Passthrough")({
      imports: [ConfigModule],
      exports: [ConfigModule],
    });
    const wired = Module("Wired")({
      imports: [Passthrough],
      provides: [DatabaseProvider],
      exports: [Database],
    });
    type WiredChannels = ChannelsOf<typeof wired>;
    const needsNothing: Equal<WiredChannels[2], never> = true;
    void needsNothing;
  });

  test("an unmet requirement cannot be laundered to no requirement", () => {
    const orphan = Module("Orphan")({
      needs: [Database],
      provides: [OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    // `_needs` must be covariant for this widening lie to be rejected:
    // contravariant, `Module<OrderRepository, never, Database>` is assignable to
    // `Module<…, never>` and launders a real unmet dependency past the very
    // check the build gate uses to decide a module is runnable.
    // @ts-expect-error Database is still an unmet requirement
    const typed: Module<OrderRepository, never, never> = orphan;
    void typed;
  });

  test("an undeclared need is an error at the module that owes it", () => {
    // `OrderRepositoryProvider` needs `Database`, nothing here provides or
    // imports it, and `needs` does not name it — an error HERE rather than an
    // obligation that travels to whoever composes the module. The marker is an
    // object with one required property so `Database` reaches the message.
    // @ts-expect-error UNDECLARED NEEDS — name it in `needs`: Database
    Module("Undeclared")({
      provides: [OrderRepositoryProvider],
      exports: [OrderRepository],
    });
  });

  test("an import's unmet needs travel without being re-declared", () => {
    // The other half of the gate, and why a `needs` list stays one line per
    // FEATURE rather than one per hop: `Importer` declares nothing, the
    // obligation still reaches its channel, and nothing is hidden — `Orphan`'s
    // type says `Database` at the `imports` entry a reader is looking at.
    const orphan = Module("Orphan")({
      needs: [Database],
      provides: [OrderRepositoryProvider],
      exports: [OrderRepository],
    });
    const importer = Module("Importer")({
      imports: [orphan],
      exports: [OrderRepository],
    });

    type Channels = ChannelsOf<typeof importer>;
    const stillOwesDatabase: Equal<Channels[2], Database> = true;
    void stillOwesDatabase;
  });

  test("declaring a need nothing owes is inert", () => {
    // `needs` says what this module expects from outside; it does not
    // manufacture an obligation. `ConfigModule` provides everything it uses,
    // so naming `Database` here changes no channel — the module still owes
    // nothing, and a composition root is not made to supply it.
    const overDeclared = Module("OverDeclared")({
      needs: [Database],
      provides: [EnvProvider, AppConfigProvider],
      exports: [AppConfig],
    });
    type Channels = ChannelsOf<typeof overDeclared>;
    const needsIsNever: Equal<Channels[2], never> = true;
    void needsIsNever;
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
