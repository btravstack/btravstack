import { Module, Port, Provider } from "@btravstack/di";
import { Ok } from "unthrown";
import { describe, expect, test } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { overridden } from "./overridden.js";
import { testRuntime } from "./test-runtime.js";

class Greeter extends Port("OverriddenGreeter")<{ readonly greet: () => string }> {}

test("the real root answers with the override's service", async () => {
  // GIVEN a real root, and the same root with its greeter overridden
  const Root = Module("OverriddenRoot")({
    provides: [Provider(Greeter)({ inject: {}, value: { greet: () => "real" } })],
    exports: [Greeter],
  });

  // WHEN the overridden composition is built and read
  const served = await Module.build(
    overridden(Root, [Provider(Greeter)({ inject: {}, value: { greet: () => "stub" } })]),
  ).map((ctx) => ctx.get(Greeter).greet());

  // THEN the override answered through the root's own exports
  expect(served).toBeOkWith("stub");
});

test("a subclass overrides a provider class in the real root", async () => {
  // GIVEN a root providing a use case class, and a double subclassing it
  class Greeting extends Provider.class("OverriddenGreeting", { inject: { greeter: Greeter } }) {
    say(): string {
      return this.deps.greeter.greet();
    }
  }
  class SilentGreeting extends Greeting {
    override say(): string {
      return "…";
    }
  }
  const Root = Module("OverriddenClassRoot")({
    provides: [Provider(Greeter)({ inject: {}, value: { greet: () => "real" } }), Greeting],
    exports: [Greeting],
  });

  // WHEN the root is built with the double in the class's place
  const served = await Module.build(overridden(Root, [SilentGreeting])).map((ctx) =>
    ctx.get(Greeting).say(),
  );

  // THEN the double answered under the class's own port
  expect(served).toBeOkWith("…");
});

test("an override the root no longer backs is a loud defect, not a silent divergence", async () => {
  // GIVEN a root that does not provide the overridden port at all
  const Root = Module("DriftedRoot")({
    provides: [],
    exports: [],
  });

  // WHEN the overridden composition is built
  const built = await Module.build(
    overridden(Root, [Provider(Greeter)({ inject: {}, value: { greet: () => "stub" } })]),
  );

  // THEN the drift is named before any factory runs
  expect(built).toBeDefectWith(
    expect.objectContaining({
      message:
        '[di] override for port "OverriddenGreeter" with nothing to override — the tree no longer provides it',
    }),
  );
});

test("an override may carry its own dependencies, resolved from the root's graph", async () => {
  // GIVEN a root with two services, and an override whose stub reads the other
  class Prefix extends Port("OverriddenPrefix")<{ readonly value: string }> {}
  const Root = Module("PrefixedRoot")({
    provides: [
      Provider(Prefix)({ inject: {}, value: { value: "re" } }),
      Provider(Greeter)({ inject: {}, value: { greet: () => "al" } }),
    ],
    exports: [Greeter],
  });

  // WHEN the override declares the sibling port as a dep
  const served = await Module.build(
    overridden(Root, [
      Provider(Greeter)({
        inject: { prefix: Prefix },
        sync: ({ prefix }) => ({ greet: () => `${prefix.value}corded` }),
      }),
    ]),
  )
    .map((ctx) => Ok(ctx.get(Greeter).greet()))
    .flatMap((r) => r);

  // THEN it was built from the root's own sibling service
  expect(served).toBeOkWith("recorded");
});

describe("an override inside a unit module", () => {
  it("is what the fork builds, while its siblings still construct", async ({
    boot,
    unitKind: { built, kind, stub, rootOf },
  }) => {
    // GIVEN a unit module building a greeter and a sibling, with the greeter
    // overridden inside the runtime's `test` kind
    const runtime = testRuntime("test", { unit: kind });
    boot(overridden(rootOf(runtime), [], { unit: { test: [stub("stub")] } }));
    await runtime.untilStarted();

    // WHEN one unit is forked and settled
    const unit = runtime.submit();
    unit.settle(Ok("done"));

    // THEN the fork built the override in the greeter's place, and the sibling beside it
    await expect(unit.result.map(() => built().toSorted())).toBeOkWith(["sibling", "stub"]);
  });

  it("an override the kind's module no longer backs is a defect at boot", async ({
    unitKind: { unrelated, stub, rootOf, start },
  }) => {
    // GIVEN a unit module that does not provide the overridden port
    const runtime = testRuntime("test", { unit: unrelated });

    // WHEN the overridden root is started
    const app = start(overridden(rootOf(runtime), [], { unit: { test: [stub("stub")] } }));

    // THEN the boot failed, naming the port and the kind
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message:
          '[core] unit override for port "UnitKindGreeter" in kind "test" with nothing to override — its module no longer provides it',
      }),
    );
  });
});
