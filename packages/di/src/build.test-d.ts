import { Err, Ok, TaggedError, type AsyncResult } from "unthrown";
import { describe, test } from "vitest";

import { Module, Port, Provider, type Context } from "./index.js";
import { type Equal } from "./type-assert.js";

class CfgError extends TaggedError("BDCfgError")<{ readonly reason: string }> {}

class Cfg extends Port("BDCfg")<{ readonly url: string }> {}
class Repo extends Port("BDRepo")<{ readonly find: () => string }> {}
class Env extends Port("BDEnv")<Record<string, string | undefined>> {}

/**
 * Recovers `Module.build`'s return type positionally, the same `ChannelsOf`
 * trick `module.test-d.ts`/`provider.test-d.ts` use for `Module`/`Provider`
 * themselves. A plain `const typed: AsyncResult<Context<X>, E> = built`
 * assignment would only prove the declared type is assignable *into*
 * whatever `built` actually carries — which stays green even if `X`/`E`
 * silently widened to `unknown` — so this instead reads the literal type
 * arguments `built`'s declared type was built from.
 */
type BuiltChannels<T> = T extends AsyncResult<infer C, infer E> ? readonly [C, E] : never;
/** Same trick one level in: recovers `Context`'s own `R` from the built context type. */
type ExportsOf<T> = T extends Context<infer R> ? R : never;

describe("Module.build", () => {
  test("a complete module's build type carries the real exports and a never error", () => {
    const mod = Module("Complete")({
      provides: [
        Provider(Cfg)({ value: { url: "u" } }),
        Provider(Repo)([Cfg], { sync: (c) => ({ find: () => c.url }) }),
      ],
      exports: [Repo],
    });
    const built = Module.build(mod);

    type Channels = BuiltChannels<typeof built>;
    const exportsIsRepo: Equal<ExportsOf<Channels[0]>, Repo> = true;
    const exportsIsNotCfg: Equal<ExportsOf<Channels[0]>, Cfg> = false;
    const errorIsNever: Equal<Channels[1], never> = true;
    const errorIsNotUnknown: Equal<Channels[1], unknown> = false;
    void built;
    void exportsIsRepo;
    void exportsIsNotCfg;
    void errorIsNever;
    void errorIsNotUnknown;
  });

  test("a module with a fallible provider carries that real error, not a widened one", () => {
    const mod = Module("Fallible")({
      provides: [
        Provider(Env)({ value: {} }),
        Provider(Cfg)([Env], {
          make: (env) =>
            env["URL"] === undefined
              ? Err(new CfgError({ reason: "unset" }))
              : Ok({ url: env["URL"] }),
        }),
      ],
      exports: [Cfg],
    });
    const built = Module.build(mod);

    type Channels = BuiltChannels<typeof built>;
    const exportsIsCfg: Equal<ExportsOf<Channels[0]>, Cfg> = true;
    const errorIsCfgError: Equal<Channels[1], CfgError> = true;
    const errorIsNotUnknown: Equal<Channels[1], unknown> = false;
    const errorIsNotNever: Equal<Channels[1], never> = false;
    void built;
    void exportsIsCfg;
    void errorIsCfgError;
    void errorIsNotUnknown;
    void errorIsNotNever;
  });

  test("a module with unmet needs does not compile", () => {
    const mod = Module("Incomplete")({
      provides: [Provider(Repo)([Cfg], { sync: (c) => ({ find: () => c.url }) })],
      exports: [Repo],
    });
    // @ts-expect-error unsatisfied dependency: Cfg — the rest parameter
    // becomes a required two-element tuple when Needs is not `never`, so
    // calling with just `mod` is an arity error at the call site. The
    // "complete module" test above is the negative control: it calls
    // `Module.build(mod)` with exactly one argument and no
    // `@ts-expect-error`, so this failure is specific to the unmet
    // dependency, not the gate misfiring on every call.
    Module.build(mod);
  });

  test("a module whose only teardown is an onStop does not compile under build", () => {
    const mod = Module("OnStopOnly")({
      // No `acquire`/`release` here — a plain `value` arm with just an
      // `onStop`. `Module.build` never opens or closes a scope
      // (`build.ts`'s `run` takes a bare `ClosableFinalisers`; only
      // `Module.scoped`/`forkScope` in `module.ts` call `createScope`), so
      // a registered `onStop` under `build` would silently never run —
      // `ScopeOf` (`provider.ts`) must put `Scope` in `Needs` exactly as it
      // already does for `acquire`/`release`.
      provides: [Provider(Cfg)({ value: { url: "u" }, onStop: () => {} })],
      exports: [Cfg],
    });
    // @ts-expect-error unsatisfied dependency: Scope — same gate `acquire`
    // triggers, now also triggered by a bare `onStop`.
    Module.build(mod);
  });
});
