import { Err, Ok, TaggedError } from "unthrown";
import { describe, test } from "vitest";

import { type Equal } from "./__tests__/type-assert.js";
import { Port, Provider, type Scope, type ServiceOf } from "./index.js";

class ConfigError extends TaggedError("ConfigError")<{ readonly reason: string }> {}
class PoolError extends TaggedError("ProvPoolError")<{ readonly url: string }> {}

class Env extends Port("Env")<Record<string, string | undefined>> {}
class AppConfig extends Port("AppConfig")<{ readonly dbUrl: string }> {}
class Logger extends Port("ProvLogger")<{ readonly log: (m: string) => void }> {}
class Repo extends Port("ProvRepo")<{ readonly find: () => string }> {}
class Pool extends Port("ProvPool")<{ readonly close: () => void }> {}

/**
 * Recovers `Provider`'s three type arguments by positional inference rather than
 * assignability: `P` sits in a contravariant position, so a plain
 * `const typed: Provider<X, Y, Z> = p` passes for a widened actual type too.
 * Combine with `Equal` to pin them exactly.
 */
type ChannelsOf<T> = T extends Provider<infer P, infer E, infer N> ? readonly [P, E, N] : never;

class RepoImpl {
  private readonly cfg: ServiceOf<AppConfig>;
  constructor({ config }: { readonly config: ServiceOf<AppConfig> }) {
    this.cfg = config;
  }
  find(): string {
    return this.cfg.dbUrl;
  }
}

describe("Provider", () => {
  test("a value provider needs nothing and cannot fail", () => {
    const p = Provider(Logger)({ inject: {}, value: { log: () => {} } });
    const typed: Provider<Logger, never, never> = p;
    void typed;

    // The assignability check above is close to vacuous — `never` is assignable
    // into a contravariant position whatever the actual type is — so pin the
    // three channels exactly.
    type Channels = ChannelsOf<typeof p>;
    const portIsLogger: Equal<Channels[0], Logger> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    const needsIsNever: Equal<Channels[2], never> = true;
    void portIsLogger;
    void errorIsNever;
    void needsIsNever;
  });

  test("deps are typed into the services record, under the names they were declared with", () => {
    Provider(AppConfig)({
      inject: { env: Env },
      sync: ({ env }) => ({ dbUrl: env["DATABASE_URL"] ?? "" }),
    });
  });

  test("a key the inject record does not declare is not on the services record", () => {
    Provider(AppConfig)({
      inject: { env: Env },
      // @ts-expect-error `logger` was never declared as a dependency
      sync: ({ env, logger }) => ({ dbUrl: (env["DATABASE_URL"] ?? "") + String(logger) }),
    });
  });

  test("a deps value that is not a port is rejected", () => {
    Provider(AppConfig)({
      // @ts-expect-error `"Env"` is a string, not a port class
      inject: { env: "Env" },
      sync: () => ({ dbUrl: "" }),
    });
  });

  test("a services record entry has the dependency's service shape, not the port", () => {
    Provider(AppConfig)({
      inject: { env: Env },
      // @ts-expect-error the entry is the env record, which has no `portId`
      sync: ({ env }) => ({ dbUrl: env.portId }),
    });
  });

  test("make infers E from the Err it returns", () => {
    const p = Provider(AppConfig)({
      inject: { env: Env },
      make: ({ env }) => {
        const url = env["DATABASE_URL"];
        return url === undefined
          ? Err(new ConfigError({ reason: "DATABASE_URL is unset" }))
          : Ok({ dbUrl: url });
      },
    });
    const typed: Provider<AppConfig, ConfigError, Env> = p;
    void typed;

    // The assignability check above stays green even if `ErrorOf` regressed to
    // widening `E` to `unknown`, so pin it exactly with a negative control.
    type Channels = ChannelsOf<typeof p>;
    const portIsAppConfig: Equal<Channels[0], AppConfig> = true;
    const errorIsConfigError: Equal<Channels[1], ConfigError> = true;
    const errorIsNotUnknown: Equal<Channels[1], unknown> = false;
    const needsIsEnv: Equal<Channels[2], Env> = true;
    void portIsAppConfig;
    void errorIsConfigError;
    void errorIsNotUnknown;
    void needsIsEnv;
  });

  test("class checks the constructor against the declared deps", () => {
    Provider(Repo)({ inject: { config: AppConfig }, class: RepoImpl });
  });

  test("a class whose constructor does not match the deps is rejected", () => {
    // @ts-expect-error RepoImpl takes an AppConfig service, not a Logger service
    Provider(Repo)({ inject: { config: Logger }, class: RepoImpl });
  });

  test("two qualifications at once are rejected", () => {
    // @ts-expect-error `value` and `sync` are mutually exclusive
    Provider(Logger)({ inject: {}, value: { log: () => {} }, sync: () => ({ log: () => {} }) });
  });

  test("onStart is optional on every arm, without reopening arm exclusivity", () => {
    const p = Provider(Logger)({
      inject: {},
      value: { log: () => {} },
      onStart: (s) => void s.log,
    });

    type Channels = ChannelsOf<typeof p>;
    const portIsLogger: Equal<Channels[0], Logger> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    // A bare `onStart` needs no `Scope` — only teardown does.
    const needsIsNever: Equal<Channels[2], never> = true;
    // Negative control: a regression letting `Hooks<S>` leak into `ScopeOf`
    // would widen `Needs` away from `never`.
    const needsIsNotUnknown: Equal<Channels[2], unknown> = false;
    void portIsLogger;
    void errorIsNever;
    void needsIsNever;
    void needsIsNotUnknown;

    // Hooks riding along does not make two real qualification arms
    // compatible — the union's own `?: never` siblings still fire.
    // @ts-expect-error `value` and `sync` are mutually exclusive even with hooks present
    Provider(Logger)({
      inject: {},
      value: { log: () => {} },
      sync: () => ({ log: () => {} }),
      onStart: () => {},
    });
  });

  test("onStop needs a Scope even without acquire/release — a value arm's onStop is still teardown", () => {
    const p = Provider(Logger)({ inject: {}, value: { log: () => {} }, onStop: (s) => void s.log });

    // `onStop` is registered on the scope exactly like `release` is, and only
    // `Module.scoped`/`forkScope` ever close one — so a provider whose only
    // teardown is an `onStop` must gate `Module.build` too, or the hook
    // silently never runs.
    type Channels = ChannelsOf<typeof p>;
    const needsIsScope: Equal<Channels[2], Scope> = true;
    // Negative control: pins `Scope` exactly, not merely "not never".
    const needsIsNotNever: Equal<Channels[2], never> = false;
    void needsIsScope;
    void needsIsNotNever;
  });

  /**
   * The three tests below are `Provider`'s analogues of `module.test-d.ts`'s
   * laundering tests. Each is written in the shape the defect actually takes —
   * an ordinary return-type annotation on a factory, no cast and no `any` —
   * because that is the form that launders a channel silently.
   */
  test("an unmet requirement cannot be laundered to no requirement", () => {
    const p = Provider(Repo)({
      inject: { config: AppConfig },
      sync: ({ config }) => ({ find: () => config.dbUrl }),
    });
    // @ts-expect-error AppConfig is still an unmet requirement
    const typed: Provider<Repo, never, never> = p;
    void typed;

    // The same lie in the form it is actually written: a factory whose declared
    // return type quietly drops the dependency. With `_needs` contravariant this
    // compiled and sailed through `Module.build`'s gate with nothing registered
    // for `AppConfig` at all.
    const makeRepoProvider = (): Provider<Repo, never, never> =>
      // @ts-expect-error AppConfig is still an unmet requirement
      Provider(Repo)({
        inject: { config: AppConfig },
        sync: ({ config }) => ({ find: () => config.dbUrl }),
      });
    void makeRepoProvider;
  });

  test("a wider error union cannot be narrowed away", () => {
    const p = Provider(AppConfig)({
      inject: { env: Env },
      make: ({ env }) => {
        const url = env["DATABASE_URL"];
        if (url === undefined) return Err(new ConfigError({ reason: "unset" }));
        if (url === "") return Err(new PoolError({ url }));
        return Ok({ dbUrl: url });
      },
    });

    type Channels = ChannelsOf<typeof p>;
    const errorIsUnion: Equal<Channels[1], ConfigError | PoolError> = true;
    void errorIsUnion;

    // @ts-expect-error ConfigError is still a possible failure, not just PoolError
    const typed: Provider<AppConfig, PoolError, Env> = p;
    void typed;

    // And the annotation form: a provider that genuinely fails cannot be
    // declared infallible. Contravariance reduced this to "is `never` assignable
    // to `ConfigError`", trivially true, and the error vanished from `E`.
    const infallible = (): Provider<AppConfig, never, never> =>
      // @ts-expect-error ConfigError is a real failure this provider can return
      Provider(AppConfig)({ inject: {}, make: () => Err(new ConfigError({ reason: "unset" })) });
    void infallible;
  });

  test("a resourceful provider cannot be laundered into needing no Scope", () => {
    // The variance leak with a silent RUNTIME consequence, which is why it gets
    // its own test. `ScopeOf` puts `Scope` in `Needs` so the graph is forced
    // through `Module.scoped`; laundered to `never` it routes to
    // `Module.build`, which opens a scope it never closes — so the `release` is
    // dropped on the floor. No type error, no runtime error, just a leak.
    const leaky = (): Provider<Pool, never, never> =>
      // @ts-expect-error Scope is still required — this provider has a release
      Provider(Pool)({
        inject: {},
        acquire: () => Ok({ close: () => {} }),
        release: (pool) => pool.close(),
      });
    void leaky;

    // Positive control: the honest annotation, which must keep compiling.
    const honest = (): Provider<Pool, never, Scope> =>
      Provider(Pool)({
        inject: {},
        acquire: () => Ok({ close: () => {} }),
        release: (pool) => pool.close(),
      });
    void honest;
  });

  test("a hook's parameter is the constructed service, not the port", () => {
    Provider(Logger)({
      inject: {},
      value: { log: () => {} },
      // @ts-expect-error the hook parameter is the service, which has no `portId`
      onStart: (s) => void s.portId,
    });
  });
});
