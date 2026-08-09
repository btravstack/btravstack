import { Ok, type AsyncResult } from "unthrown";
import { describe, test } from "vitest";

import { Module, Port, Provider, type AnyPort, type Scope } from "./index.js";
import { type Equal } from "./type-assert.js";

class Pool extends Port("SPool")<{ readonly close: () => Promise<void> }> {}

const PoolProvider = Provider(Pool)({
  acquire: () => Ok({ close: async () => {} }),
  release: (pool) => pool.close(),
});

const Resourceful = Module("Resourceful")({ provides: [PoolProvider], exports: [Pool] });

/**
 * Same positional-inference trick `module.test-d.ts`/`build.test-d.ts` use:
 * `Module`'s `_exports`/`_needs` are contravariant/covariant phantom fields,
 * so a plain `const typed: Module<X, E, N> = m` assignment only proves the
 * declared type is assignable *into* whatever `m` actually carries — it
 * would stay green even if `Needs` silently dropped `Scope` (or widened to
 * `unknown`). Reading the literal type arguments back out pins the value,
 * not just its assignability.
 */
type ChannelsOf<T> = T extends Module<infer X, infer E, infer N> ? readonly [X, E, N] : never;

/** Same trick one level in, for what `Module.scoped` itself returns. */
type ScopedChannels<T> = T extends AsyncResult<infer A, infer E> ? readonly [A, E] : never;

/**
 * `Scope` is deliberately *not* rejected by a type-level guard on
 * `Provider`'s port parameter — that was tried and reverted (see `Scope`'s
 * own doc comment in `port.ts`, and `build.ts`'s `plan()`, which now carries
 * the real, runtime check). A guard keyed on `P`'s static type would make
 * this ordinary, port-generic helper fail to typecheck too, since a
 * conditional on `P` can't reduce while `P` is still an unresolved type
 * parameter — this function compiling at all, with no `@ts-expect-error`
 * below, is the regression test for that false positive.
 */
function wrap<P extends AnyPort>(port: P) {
  return Provider(port);
}

describe("resources", () => {
  test("acquire puts Scope in Needs", () => {
    const typed: Module<Pool, never, Scope> = Resourceful;
    void typed;

    type Channels = ChannelsOf<typeof Resourceful>;
    const exportsIsPool: Equal<Channels[0], Pool> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    const needsIsScope: Equal<Channels[2], Scope> = true;
    // Negative control: Needs must be pinned to exactly `Scope`, not merely
    // "not never" — a regression that widened it to `unknown` or dropped it
    // to `never` would otherwise slip past the positive assertions above.
    const needsIsNotNever: Equal<Channels[2], never> = false;
    void exportsIsPool;
    void errorIsNever;
    void needsIsScope;
    void needsIsNotNever;
  });

  test("a resourceful graph is rejected by build", () => {
    // @ts-expect-error unsatisfied dependency: Scope
    Module.build(Resourceful);
  });

  test("a resourceful graph is accepted by scoped", () => {
    const used = Module.scoped(Resourceful, (ctx) => Ok(ctx.get(Pool)).toAsync());

    type Channels = ScopedChannels<typeof used>;
    const valueIsPoolService: Equal<Channels[0], { readonly close: () => Promise<void> }> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    // Negative control: pins `use`'s callback result as the real return
    // value, not a widened `unknown` that would pass regardless of what
    // `Module.scoped` actually resolves to.
    const errorIsNotUnknown: Equal<Channels[1], unknown> = false;
    void used;
    void valueIsPoolService;
    void errorIsNever;
    void errorIsNotUnknown;
  });

  test("scoped still gates on a genuinely unmet dependency, not just Scope", () => {
    class Other extends Port("SOther")<{ readonly n: number }> {}
    const needsOther = Module("NeedsOther")({
      provides: [
        Provider(Pool)([Other], {
          acquire: () => Ok({ close: async () => {} }),
          release: (pool) => pool.close(),
        }),
      ],
      exports: [Pool],
    });
    // @ts-expect-error unsatisfied dependency: Other (Scope alone is excused)
    Module.scoped(needsOther, (ctx) => Ok(ctx.get(Pool)).toAsync());
  });

  test("a port-generic helper still typechecks", () => {
    void wrap;
  });

  test("hooks on the resourceful arm do not disturb Needs", () => {
    const hooked = Provider(Pool)({
      acquire: () => Ok({ close: async () => {} }),
      release: (pool) => pool.close(),
      onStart: (pool) => void pool.close(),
      onStop: (pool) => void pool.close(),
    });
    const mod = Module("HookedResourceful")({ provides: [hooked], exports: [Pool] });

    // Pins that `Hooks<S>`'s intersection still lets `ScopeOf` see the
    // `acquire` key through it — `Needs` must stay exactly `Scope`, not
    // widen (or, worse, silently drop back to `never` if the hooks somehow
    // shadowed `acquire` in the structural check).
    type Channels = ChannelsOf<typeof mod>;
    const needsIsScope: Equal<Channels[2], Scope> = true;
    const needsIsNotNever: Equal<Channels[2], never> = false;
    void needsIsScope;
    void needsIsNotNever;
  });
});
