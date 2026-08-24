import { Module, Port, Provider } from "@btravstack/di";
import { Ok } from "unthrown";
import { expect, test } from "vitest";

import { overridden } from "./overridden.js";

class Greeter extends Port("OverriddenGreeter")<{ readonly greet: () => string }> {}

test("the real root answers with the override's service", async () => {
  // GIVEN a real root, and the same root with its greeter overridden
  const Root = Module("OverriddenRoot")({
    provides: [Provider(Greeter)({ value: { greet: () => "real" } })],
    exports: [Greeter],
  });

  // WHEN the overridden composition is built and read
  const served = await Module.build(
    overridden(Root, [Provider(Greeter)({ value: { greet: () => "stub" } })]),
  ).map((ctx) => ctx.get(Greeter).greet());

  // THEN the override answered through the root's own exports
  expect(served).toBeOkWith("stub");
});

test("an override the root no longer backs is a loud defect, not a silent divergence", async () => {
  // GIVEN a root that does not provide the overridden port at all
  const Root = Module("DriftedRoot")({
    provides: [],
    exports: [],
  });

  // WHEN the overridden composition is built
  const built = await Module.build(
    overridden(Root, [Provider(Greeter)({ value: { greet: () => "stub" } })]),
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
      Provider(Prefix)({ value: { value: "re" } }),
      Provider(Greeter)({ value: { greet: () => "al" } }),
    ],
    exports: [Greeter],
  });

  // WHEN the override declares the sibling port as a dep
  const served = await Module.build(
    overridden(Root, [
      Provider(Greeter)(
        { prefix: Prefix },
        { sync: ({ prefix }) => ({ greet: () => `${prefix.value}corded` }) },
      ),
    ]),
  )
    .map((ctx) => Ok(ctx.get(Greeter).greet()))
    .flatMap((r) => r);

  // THEN it was built from the root's own sibling service
  expect(served).toBeOkWith("recorded");
});
