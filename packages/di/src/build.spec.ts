import { Err, Ok, OkAsync, TaggedError, fromSafePromise } from "unthrown";
import { expect, test, vi } from "vitest";

import { Module, Port, Provider, overrideProvider } from "./index.js";

class AError extends TaggedError("AError")<{ readonly why: string }> {}
class BError extends TaggedError("BError")<{ readonly why: string }> {}

class A extends Port("BA")<{ readonly v: string }> {}
class B extends Port("BB")<{ readonly v: string }> {}
class C extends Port("BC")<{ readonly v: string }> {}

test("providers construct in dependency order, not declaration order", async () => {
  const order: string[] = [];
  const mod = Module("Ordered")({
    provides: [
      Provider(C)(
        { b: B },
        {
          sync: ({ b }) => {
            order.push("C");
            return { v: `${b.v}C` };
          },
        },
      ),
      Provider(B)(
        { a: A },
        {
          sync: ({ a }) => {
            order.push("B");
            return { v: `${a.v}B` };
          },
        },
      ),
      Provider(A)({
        sync: () => {
          order.push("A");
          return { v: "A" };
        },
      }),
    ],
    exports: [C],
  });

  const built = await Module.build(mod);
  expect(order).toEqual(["A", "B", "C"]);
  expect(built).toBeOk();
});

test("a port shared by two branches constructs exactly once", async () => {
  const made = vi.fn(() => ({ v: "A" }));
  const shared = Module("Shared")({
    provides: [Provider(A)({ sync: made })],
    exports: [A],
  });
  const left = Module("Left")({
    imports: [shared],
    provides: [Provider(B)({ a: A }, { sync: ({ a }) => ({ v: a.v }) })],
    exports: [B],
  });
  const right = Module("Right")({
    imports: [shared],
    provides: [Provider(C)({ a: A }, { sync: ({ a }) => ({ v: a.v }) })],
    exports: [C],
  });
  const app = Module("App")({ imports: [left, right], exports: [left, right] });

  await Module.build(app);
  expect(made).toHaveBeenCalledTimes(1);
});

test("a cycle within one module is a defect, reported before any factory runs", async () => {
  const ran = vi.fn();
  const cyclic = Module("Cyclic")({
    provides: [
      Provider(A)({ b: B }, { sync: ran as never }),
      Provider(B)({ a: A }, { sync: ran as never }),
    ],
    exports: [A],
  });
  const built = await Module.build(cyclic);
  expect(built).toBeDefect();
  expect(ran).not.toHaveBeenCalled();
});

test("two distinct providers for one port are a defect, before any factory runs", async () => {
  const ran = vi.fn(() => ({ v: "A" }));
  const dup = Module("Dup")({
    provides: [Provider(A)({ sync: ran }), Provider(A)({ sync: ran })],
    exports: [A],
  });
  const built = await Module.build(dup);
  expect(built).toBeDefect();
  expect(ran).not.toHaveBeenCalled();
});

test("the error from a parallel level is the first in declaration order", async () => {
  const slowFailure = Module("Slow")({
    provides: [
      Provider(A)({
        make: () => OkAsync().flatMap(() => Err(new AError({ why: "a" }))),
      }),
      Provider(B)({ make: () => Err(new BError({ why: "b" })) }),
    ],
    exports: [A, B],
  });
  const built = await Module.build(slowFailure);
  // B lands first in wall-clock terms; A wins because it is declared first.
  expect(built).toBeErrTagged("AError");
});

test(
  "two providers at the same level construct concurrently, not one after another",
  { timeout: 5000 },
  async () => {
    // The one guarantee in the design doc's "Independent providers construct
    // in parallel" section with no repo coverage until now. Written as a
    // deadlock rather than with timers, so it cannot pass or fail on timing:
    // each provider announces itself and then blocks on a barrier that only
    // the *second* arrival opens. Under sequential construction the first
    // provider's promise never settles, so the second is never started, so
    // the barrier is never opened — `Module.build` never resolves and the
    // test fails on its timeout. Under concurrent construction both arrive,
    // the barrier opens, and both resolve. There is no schedule under which a
    // sequential implementation passes.
    const starts: string[] = [];
    // The executor runs synchronously, so `openBarrier` is definitely assigned
    // before `arrive` can be called. (`Promise.withResolvers` would say this
    // more directly but is newer than this project's `lib` target.)
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const arrive = (name: string): Promise<void> => {
      starts.push(name);
      if (starts.length === 2) openBarrier();
      return barrier;
    };

    const concurrent = Module("Concurrent")({
      provides: [
        Provider(A)({
          make: () => fromSafePromise(() => arrive("A")).map(() => ({ v: "A" })),
        }),
        Provider(B)({
          make: () => fromSafePromise(() => arrive("B")).map(() => ({ v: "B" })),
        }),
      ],
      exports: [A, B],
    });

    const built = await Module.build(concurrent);
    expect(built).toBeOk();
    // Both genuinely ran; asserted as a set, since *which* order two
    // concurrent factories announce themselves in is not what this test is
    // about — "the error from a parallel level is the first in declaration
    // order" above is the test that pins ordering.
    expect(starts.toSorted()).toEqual(["A", "B"]);
  },
);

test("a dependency no provider supplies is a defect, before any factory runs", async () => {
  const sibling = vi.fn(() => ({ v: "A" }));
  const dependent = vi.fn(() => ({ v: "C" }));
  const orphan = Module("Orphan")({
    // Declared, so the module itself is legal — what is missing is anyone to
    // supply it, which is the runtime path this test is about.
    needs: [B],
    provides: [
      Provider(A)({ sync: sibling }),
      // `B` is provided by nobody, here or in any import.
      Provider(C)({ a: A, b: B }, { sync: dependent }),
    ],
    exports: [A, C],
  });

  // `Module.build`'s type-level gate catches this first — `orphan`'s `Needs`
  // is `B`, so the honest call is an arity error. Cast past it to reach the
  // runtime path a JavaScript consumer, or a `Needs` laundered through a
  // widening annotation, actually takes.
  const built = await Module.build<never, never, never>(orphan as never);

  expect(built).toBeDefect();
  // The point of moving the check into `plan`: `A` is perfectly constructible
  // and sits in an earlier level than `C`, so before the fix it had already
  // been built by the time the missing `B` surfaced — the failure was not
  // pre-construction at all, and arrived as `context.ts`'s "[di] no service
  // registered", which reads like a bug in this package rather than a missing
  // provider in the caller's graph.
  expect(sibling).not.toHaveBeenCalled();
  expect(dependent).not.toHaveBeenCalled();
  const cause = built.isDefect() ? built.cause : undefined;
  expect(String(cause)).toContain(`[di] no provider for port "BB"`);
  expect(String(cause)).toContain(`required by "BC"`);
});

test("a built context resolves an exported port", async () => {
  const mod = Module("Exported")({
    provides: [Provider(A)({ value: { v: "A" } })],
    exports: [A],
  });
  const built = await Module.build(mod);
  expect(built.isOk() && built.value.get(A).v).toBe("A");
});

test("an override replaces the base provider, which is never constructed", async () => {
  // GIVEN a graph whose base provider records construction, and an override for its port
  let baseConstructed = false;
  const mod = Module("Overridden")({
    provides: [
      Provider(A)({
        sync: () => {
          baseConstructed = true;
          return { v: "base" };
        },
      }),
      overrideProvider(Provider(A)({ value: { v: "override" } })),
    ],
    exports: [A],
  });

  // WHEN the graph is built
  const built = await Module.build(mod).map((ctx) => ({
    served: ctx.get(A).v,
    baseConstructed,
  }));

  // THEN the override's service answers and the base never ran
  expect(built).toBeOkWith({ served: "override", baseConstructed: false });
});

test("a resourceful base is replaced whole — its acquire never runs", async () => {
  // GIVEN a resourceful base provider and a value override for its port
  let acquired = false;
  const mod = Module("OverriddenResource")({
    provides: [
      Provider(A)({
        acquire: () => {
          acquired = true;
          return Ok({ v: "base" });
        },
        release: () => {},
      }),
      overrideProvider(Provider(A)({ value: { v: "override" } })),
    ],
    exports: [A],
  });

  // WHEN the graph is built and read — `build`, because the override erased
  // the graph's one resource along with its provider... except `Scope` rides
  // the module TYPE, so `scoped` is still the entry point that accepts it
  const built = await Module.scoped(mod, (ctx) => OkAsync({ served: ctx.get(A).v, acquired }));

  // THEN the override's value answers and no resource was ever acquired
  expect(built).toBeOkWith({ served: "override", acquired: false });
});

test("an override with nothing to override is a wiring defect", async () => {
  // GIVEN an override for a port no provider in the tree supplies
  const mod = Module("Orphaned")({
    provides: [overrideProvider(Provider(A)({ value: { v: "override" } }))],
    exports: [A],
  });

  // WHEN the graph is built
  const built = await Module.build(mod);

  // THEN the defect names the port and the drift
  expect(built).toBeDefectWith(
    expect.objectContaining({
      message:
        '[di] override for port "BA" with nothing to override — the tree no longer provides it',
    }),
  );
});

test("two overrides for one port are the duplicate defect", async () => {
  // GIVEN two overrides for the same port beside its base
  const mod = Module("DoublyOverridden")({
    provides: [
      Provider(A)({ value: { v: "base" } }),
      overrideProvider(Provider(A)({ value: { v: "one" } })),
      overrideProvider(Provider(A)({ value: { v: "two" } })),
    ],
    exports: [A],
  });

  // WHEN the graph is built
  const built = await Module.build(mod);

  // THEN the defect is the duplicate, spelled for overrides
  expect(built).toBeDefectWith(
    expect.objectContaining({ message: '[di] two overrides registered for port "BA"' }),
  );
});

test("an override inherits its base's declaration position — onStart order is untouched", async () => {
  // GIVEN two started providers, the first of them overridden (with the
  // override itself DECLARED last, where the old resolution would leave it)
  const started: string[] = [];
  const mod = Module("OverriddenInPlace")({
    provides: [
      Provider(A)({ value: { v: "base" }, onStart: () => void started.push("A-base") }),
      Provider(B)({ value: { v: "b" }, onStart: () => void started.push("B") }),
      overrideProvider(
        Provider(A)({ value: { v: "override" }, onStart: () => void started.push("A-override") }),
      ),
    ],
    exports: [A, B],
  });

  // WHEN the graph is built and its onStart hooks have fired
  const order = await Module.build(mod).map(() => started);

  // THEN the override fired in A's own position, ahead of B — not at the tail
  expect(order).toBeOkWith(["A-override", "B"]);
});
