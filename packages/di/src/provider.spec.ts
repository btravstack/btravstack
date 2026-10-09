import { Err, Ok, TaggedError } from "unthrown";
import { expect, test } from "vitest";
// Registers the `toBeOkWith` / `toBeErrTagged` / `toBeDefect` matchers at
// runtime (already wired via `setupFiles` in vitest.config.ts) and, just as
// importantly for `tsc --noEmit`, pulls its `declare module "vitest"` type
// augmentation into this file's compilation — the augmentation is only
// picked up by the type checker where the module is actually imported.
// oxlint-disable-next-line import/no-unassigned-import
import "@unthrown/vitest";

import { Module, Port, Provider, overrideProvider } from "./index.js";

class BoomError extends TaggedError("BoomError")<{ readonly why: string }> {}
class Value extends Port("PValue")<{ readonly n: number }> {}
class Seed extends Port("PSeed")<number> {}

test("a value provider declares no deps", () => {
  // GIVEN a provider bound to a literal, injecting nothing
  const p = Provider(Value)({ inject: {}, value: { n: 1 } });

  // WHEN its declared dependencies are read
  // THEN there are none
  expect(p.deps).toEqual([]);
});

test("a value provider yields its service", async () => {
  // GIVEN a provider bound to a literal
  const p = Provider(Value)({ inject: {}, value: { n: 1 } });

  // WHEN it is constructed
  // THEN the literal is what comes back
  await expect(p.construct([])).resolves.toBeOkWith({ n: 1 });
});

test("a sync provider receives its dependencies by name", async () => {
  // GIVEN a provider injecting one port under a name its factory destructures
  const p = Provider(Value)({ inject: { seed: Seed }, sync: ({ seed }) => ({ n: seed + 1 }) });

  // WHEN it is constructed with that dependency resolved
  // THEN the factory saw it under the name `inject` gave it
  await expect(p.construct([1])).resolves.toBeOkWith({ n: 2 });
});

test("an EMPTY inject record still hands the factory a record, not nothing", async () => {
  // GIVEN a provider whose factory counts the keys it was handed. Every
  // provider is handed exactly one services record, so a caller who wrote
  // `inject: {}` gets `{}` — not the `undefined` a key count would hand them
  const p = Provider(Value)({
    inject: {},
    sync: (services) => ({ n: Object.keys(services).length }),
  });

  // WHEN it is constructed
  // THEN the factory was handed a record, and it was empty
  await expect(p.construct([])).resolves.toBeOkWith({ n: 0 });
});

test("a make provider propagates the Err it returns", async () => {
  // GIVEN a fallible provider whose factory answers Err
  const p = Provider(Value)({ inject: {}, make: () => Err(new BoomError({ why: "nope" })) });

  // WHEN it is constructed
  // THEN that error is what the construction carries
  await expect(p.construct([])).resolves.toBeErrTagged("BoomError");
});

test("a throw inside a factory becomes a defect, not an error", async () => {
  // GIVEN a provider whose factory throws rather than answering a Result
  const p = Provider(Value)({
    inject: {},
    sync: () => {
      // Deliberate: this is exactly the case under test — an unmodeled throw
      // from a factory must land as a Defect, not propagate or become an Err.
      // oxlint-disable-next-line unthrown/no-throw
      throw new Error("kaboom");
    },
  });

  // WHEN it is constructed
  // THEN the throw landed on the defect channel rather than the error one
  await expect(p.construct([])).resolves.toBeDefect();
});

test("a class provider constructs with the resolved dependencies", async () => {
  // GIVEN a class arm over one injected port
  class Impl {
    private readonly seed: number;
    constructor({ seed }: { readonly seed: number }) {
      this.seed = seed;
    }
    get n(): number {
      return this.seed + 1;
    }
  }
  const p = Provider(Value)({ inject: { seed: Seed }, class: Impl });

  // WHEN it is constructed with that dependency resolved
  // THEN an instance of that class came back, built from the services record.
  // `constructor` inside the matcher is what pins the class without a second
  // assertion — asymmetric matchers read through the prototype chain
  await expect(p.construct([41])).resolves.toBeOkWith(
    expect.objectContaining({ n: 42, constructor: Impl }),
  );
});

test("an Ok result from make is passed through unchanged", async () => {
  // GIVEN a fallible provider whose factory answers Ok
  const p = Provider(Value)({ inject: {}, make: () => Ok({ n: 3 }) });

  // WHEN it is constructed
  // THEN the value is passed through untouched
  await expect(p.construct([])).resolves.toBeOkWith({ n: 3 });
});

class Doubled extends Provider.class("PDoubled", { inject: { seed: Seed } }) {
  n(): number {
    return this.twice(this.deps.seed);
  }
  private twice(value: number): number {
    return value * 2;
  }
}
const seed = Provider(Seed)({ inject: {}, value: 21 });

test("a provider class is its own port, provider and service", async () => {
  // GIVEN a module providing and exporting the class itself
  const App = Module("PClassApp")({ provides: [seed, Doubled], exports: [Doubled] });

  // WHEN it is built and the class read back
  const built = Module.build(App).map((ctx) => {
    const service = ctx.get(Doubled);
    return { n: service.n(), instance: service instanceof Doubled };
  });

  // THEN it is an instance built from the injected seed, its helper included
  await expect(built).resolves.toBeOkWith({ n: 42, instance: true });
});

test("a subclass of a provider class provides the same port", async () => {
  // GIVEN a double overriding a method, provided in the class's place
  class FakeDoubled extends Doubled {
    override n(): number {
      return -1;
    }
  }
  const App = Module("PClassFake")({ provides: [seed, FakeDoubled], exports: [Doubled] });

  // WHEN it is built and the original class read back
  const built = Module.build(App).map((ctx) => ctx.get(Doubled).n());

  // THEN the double answered under the original port, not a second one sharing its id
  await expect(built).resolves.toBeOkWith(-1);
});

test("an override of a provider class carries its inherited statics", async () => {
  // GIVEN the class overridden by a double, through the override brand
  class FakeDoubled extends Doubled {
    override n(): number {
      return 0;
    }
  }
  const App = Module("PClassOverride")({
    provides: [seed, Doubled, overrideProvider(FakeDoubled)],
    exports: [Doubled],
  });

  // WHEN it is built
  const built = Module.build(App).map((ctx) => ctx.get(Doubled).n());

  // THEN the double replaced the class
  await expect(built).resolves.toBeOkWith(0);
});
