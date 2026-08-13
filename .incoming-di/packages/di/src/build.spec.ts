import { Err, Ok, TaggedError, fromSafePromise } from "unthrown";
import { expect, test, vi } from "vitest";

import { Module, Port, Provider } from "./index.js";

class AError extends TaggedError("AError")<{ readonly why: string }> {}
class BError extends TaggedError("BError")<{ readonly why: string }> {}

class A extends Port("BA")<{ readonly v: string }> {}
class B extends Port("BB")<{ readonly v: string }> {}
class C extends Port("BC")<{ readonly v: string }> {}

test("providers construct in dependency order, not declaration order", async () => {
  const order: string[] = [];
  const mod = Module("Ordered")({
    provides: [
      Provider(C)([B], {
        sync: (b) => {
          order.push("C");
          return { v: `${b.v}C` };
        },
      }),
      Provider(B)([A], {
        sync: (a) => {
          order.push("B");
          return { v: `${a.v}B` };
        },
      }),
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
    provides: [Provider(B)([A], { sync: (a) => ({ v: a.v }) })],
    exports: [B],
  });
  const right = Module("Right")({
    imports: [shared],
    provides: [Provider(C)([A], { sync: (a) => ({ v: a.v }) })],
    exports: [C],
  });
  const app = Module("App")({ imports: [left, right], exports: [left, right] });

  await Module.build(app);
  expect(made).toHaveBeenCalledTimes(1);
});

test("a cycle within one module is a defect, reported before any factory runs", async () => {
  const ran = vi.fn();
  const cyclic = Module("Cyclic")({
    provides: [Provider(A)([B], { sync: ran as never }), Provider(B)([A], { sync: ran as never })],
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
        make: () =>
          Ok(undefined)
            .toAsync()
            .flatMap(() => Err(new AError({ why: "a" }))),
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
    provides: [
      Provider(A)({ sync: sibling }),
      // `B` is provided by nobody, here or in any import.
      Provider(C)([A, B], { sync: dependent }),
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
