import { Err, Ok, TaggedError } from "unthrown";
import { describe, test } from "vitest";

import { Port, Provider, type Scope, type ServiceOf } from "./index.js";
import { type Equal } from "./type-assert.js";

class ConfigError extends TaggedError("ConfigError")<{ readonly reason: string }> {}
class PoolError extends TaggedError("ProvPoolError")<{ readonly url: string }> {}

class Env extends Port("Env")<Record<string, string | undefined>> {}
class AppConfig extends Port("AppConfig")<{ readonly dbUrl: string }> {}
class Logger extends Port("ProvLogger")<{ readonly log: (m: string) => void }> {}
class Repo extends Port("ProvRepo")<{ readonly find: () => string }> {}
class Pool extends Port("ProvPool")<{ readonly close: () => void }> {}

/**
 * Recovers `Provider`'s three type arguments by direct positional inference
 * against the same generic interface, rather than by assignability. `P` sits
 * in a contravariant field position (`_port`), so a plain `const typed:
 * Provider<X, Y, Z> = p` assignment only proves `X` is assignable *into*
 * whatever the value actually carries — a narrower or unrelated declared
 * type, or a widened actual type like `unknown`, can pass that check
 * regardless. (`_error`/`_needs` are covariant since the variance fix — see
 * `Provider`'s own doc comment — so assignment *does* now catch a narrowing
 * lie on those two, which the three "cannot be laundered" tests below rely
 * on. Pinning with `Equal` is still the stronger check, and stays the
 * default here.) Matching `T` against `Provider<infer P, infer E, infer N>`
 * reads the literal type arguments `p`'s declared type was built from,
 * sidestepping field variance entirely — combine with `Equal` to pin them
 * exactly.
 */
type ChannelsOf<T> = T extends Provider<infer P, infer E, infer N> ? readonly [P, E, N] : never;

class RepoImpl {
  private readonly cfg: ServiceOf<AppConfig>;
  constructor(cfg: ServiceOf<AppConfig>) {
    this.cfg = cfg;
  }
  find(): string {
    return this.cfg.dbUrl;
  }
}

describe("Provider", () => {
  test("a value provider needs nothing and cannot fail", () => {
    const p = Provider(Logger)({ value: { log: () => {} } });
    const typed: Provider<Logger, never, never> = p;
    void typed;

    // The assignability check above is close to vacuous here: `never` is
    // assignable into a contravariant parameter position regardless of what
    // the actual type is, so it would pass even if `E`/`N` weren't really
    // `never`. Pin the three channels exactly.
    type Channels = ChannelsOf<typeof p>;
    const portIsLogger: Equal<Channels[0], Logger> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    const needsIsNever: Equal<Channels[2], never> = true;
    void portIsLogger;
    void errorIsNever;
    void needsIsNever;
  });

  test("deps are typed into the factory parameters, positionally", () => {
    Provider(AppConfig)([Env], {
      sync: (env) => ({ dbUrl: env["DATABASE_URL"] ?? "" }),
    });
  });

  test("a factory parameter has the dependency's service shape, not the port", () => {
    Provider(AppConfig)([Env], {
      // @ts-expect-error the parameter is the env record, which has no `portId`
      sync: (env) => ({ dbUrl: env.portId }),
    });
  });

  test("make infers E from the Err it returns", () => {
    const p = Provider(AppConfig)([Env], {
      make: (env) => {
        const url = env["DATABASE_URL"];
        return url === undefined
          ? Err(new ConfigError({ reason: "DATABASE_URL is unset" }))
          : Ok({ dbUrl: url });
      },
    });
    const typed: Provider<AppConfig, ConfigError, Env> = p;
    void typed;

    // The assignability check above only proves `ConfigError` is assignable
    // *into* `p`'s actual error channel — it stays green even if `ErrorOf`
    // regressed to widening `E` to `unknown` (a wider type is always
    // assignable into a contravariant parameter). Pin it exactly, and prove
    // the hole is closed with a negative control against `unknown`.
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
    Provider(Repo)([AppConfig], { class: RepoImpl });
  });

  test("a class whose constructor does not match the deps is rejected", () => {
    // @ts-expect-error RepoImpl takes an AppConfig service, not a Logger service
    Provider(Repo)([Logger], { class: RepoImpl });
  });

  test("two qualifications at once are rejected", () => {
    // @ts-expect-error `value` and `sync` are mutually exclusive
    Provider(Logger)({ value: { log: () => {} }, sync: () => ({ log: () => {} }) });
  });

  test("onStart is optional on every arm, without reopening arm exclusivity", () => {
    const p = Provider(Logger)({
      value: { log: () => {} },
      onStart: (s) => void s.log,
    });

    // The assignability check style used elsewhere in this file only proves
    // `never` is assignable *into* a contravariant slot, which passes
    // regardless of whether hooks disturbed anything — pin the channels
    // exactly instead, same as every other test here.
    type Channels = ChannelsOf<typeof p>;
    const portIsLogger: Equal<Channels[0], Logger> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    // A bare `onStart` (no `acquire`, no `onStop`) needs no `Scope` — only
    // teardown (`release`/`onStop`) does; see "onStop needs a Scope..." below.
    const needsIsNever: Equal<Channels[2], never> = true;
    // Negative control: a regression that let `Hooks<S>`'s intersection leak
    // into `ErrorOf`/`ScopeOf` (e.g. by making `O extends { acquire: ... }`
    // spuriously true) would widen `Needs` away from `never` — pin against
    // that, not just check it's `never`.
    const needsIsNotUnknown: Equal<Channels[2], unknown> = false;
    void portIsLogger;
    void errorIsNever;
    void needsIsNever;
    void needsIsNotUnknown;

    // Hooks riding along does not make two real qualification arms
    // compatible — the union's own `?: never` siblings still fire.
    // @ts-expect-error `value` and `sync` are mutually exclusive even with hooks present
    Provider(Logger)({
      value: { log: () => {} },
      sync: () => ({ log: () => {} }),
      onStart: () => {},
    });
  });

  test("onStop needs a Scope even without acquire/release — a value arm's onStop is still teardown", () => {
    const p = Provider(Logger)({
      value: { log: () => {} },
      onStop: (s) => void s.log,
    });

    // `onStop` is registered on the scope exactly like `release` is
    // (`lifecycle.ts`'s `constructLevel`) — only `Module.scoped`/`forkScope`
    // ever open and close one, so a provider whose only teardown is an
    // `onStop` must gate `Module.build` the same way `acquire`/`release`
    // already does, or the hook silently never runs (`Module.build` never
    // closes the throwaway scope it builds against).
    type Channels = ChannelsOf<typeof p>;
    const needsIsScope: Equal<Channels[2], Scope> = true;
    // Negative control: pins `Scope` exactly, not merely "not never" — a
    // regression that widened `Needs` to `unknown` instead of `Scope` would
    // otherwise slip past a bare "is it never" check.
    const needsIsNotNever: Equal<Channels[2], never> = false;
    void needsIsScope;
    void needsIsNotNever;
  });

  /**
   * The three tests below are `Provider`'s analogues of `module.test-d.ts`'s
   * "an unmet requirement cannot be laundered to no requirement" and "a wider
   * error union cannot be narrowed away", plus one more for the `Scope` case.
   * Task 4 made `Module`'s `_error`/`_needs` covariant and wrote those two
   * tests; `Provider` was left contravariant and untested, which is precisely
   * why the drift survived ten tasks. Each is written in the shape the defect
   * actually takes in real code — an ordinary return-type annotation on a
   * factory function, no cast and no `any` — because that is the form that
   * launders the channel silently.
   */
  test("an unmet requirement cannot be laundered to no requirement", () => {
    const p = Provider(Repo)([AppConfig], { sync: (cfg) => ({ find: () => cfg.dbUrl }) });
    // @ts-expect-error AppConfig is still an unmet requirement
    const typed: Provider<Repo, never, never> = p;
    void typed;

    // The same lie in the form it is actually written: a factory whose
    // declared return type quietly drops the dependency. With `_needs`
    // contravariant this compiled, and the resulting `Provider<Repo, never,
    // never>` sailed through `Module.build`'s `[N] extends [never]` gate with
    // nothing registered for `AppConfig` at all.
    const makeRepoProvider = (): Provider<Repo, never, never> =>
      // @ts-expect-error AppConfig is still an unmet requirement
      Provider(Repo)([AppConfig], { sync: (cfg) => ({ find: () => cfg.dbUrl }) });
    void makeRepoProvider;
  });

  test("a wider error union cannot be narrowed away", () => {
    const p = Provider(AppConfig)([Env], {
      make: (env) => {
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
    // declared infallible. Contravariance made this reduce to "is `never`
    // assignable to `ConfigError`" — trivially true — so the error vanished
    // from the module's `E` and from `Module.build`'s result type.
    const infallible = (): Provider<AppConfig, never, never> =>
      // @ts-expect-error ConfigError is a real failure this provider can return
      Provider(AppConfig)({ make: () => Err(new ConfigError({ reason: "unset" })) });
    void infallible;
  });

  test("a resourceful provider cannot be laundered into needing no Scope", () => {
    // The variance leak with a silent *runtime* consequence, which is why it
    // gets its own test rather than riding along with the `_needs` case above.
    // `ScopeOf` puts `Scope` in this provider's `Needs` exactly so the graph
    // is forced through `Module.scoped`, the only entry point that closes the
    // scope it opens. Laundered to `never`, it routes to `Module.build`
    // instead — which creates a `createScope()` it never closes (`module.ts`),
    // so the `release` registered in `lifecycle.ts`'s `constructLevel` is
    // dropped on the floor and the pool is never closed. No type error, no
    // runtime error, just a leak: the same hole Task 6 closed from the
    // scope-unwind side, reopened from the declaration side.
    const leaky = (): Provider<Pool, never, never> =>
      // @ts-expect-error Scope is still required — this provider has a release
      Provider(Pool)({
        acquire: () => Ok({ close: () => {} }),
        release: (pool) => pool.close(),
      });
    void leaky;

    // Positive control: the honest annotation, which must keep compiling.
    const honest = (): Provider<Pool, never, Scope> =>
      Provider(Pool)({
        acquire: () => Ok({ close: () => {} }),
        release: (pool) => pool.close(),
      });
    void honest;
  });

  test("a hook's parameter is the constructed service, not the port", () => {
    Provider(Logger)({
      value: { log: () => {} },
      // @ts-expect-error the hook parameter is the service, which has no `portId`
      onStart: (s) => void s.portId,
    });
  });
});
