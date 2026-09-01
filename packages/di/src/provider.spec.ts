import { Err, Ok, TaggedError } from "unthrown";
import { expect, test } from "vitest";
// Registers the `toBeOkWith` / `toBeErrTagged` / `toBeDefect` matchers at
// runtime (already wired via `setupFiles` in vitest.config.ts) and, just as
// importantly for `tsc --noEmit`, pulls its `declare module "vitest"` type
// augmentation into this file's compilation — the augmentation is only
// picked up by the type checker where the module is actually imported.
// oxlint-disable-next-line import/no-unassigned-import
import "@unthrown/vitest";

import { Port, Provider } from "./index.js";

class BoomError extends TaggedError("BoomError")<{ readonly why: string }> {}
class Value extends Port("PValue")<{ readonly n: number }> {}
class Seed extends Port("PSeed")<number> {}

test("a value provider yields its service and declares no deps", async () => {
  const p = Provider(Value)({ inject: {}, value: { n: 1 } });
  expect(p.deps).toEqual([]);
  await expect(p.construct([])).resolves.toBeOkWith({ n: 1 });
});

test("a sync provider receives its dependencies by name", async () => {
  const p = Provider(Value)({ inject: { seed: Seed }, sync: ({ seed }) => ({ n: seed + 1 }) });
  await expect(p.construct([1])).resolves.toBeOkWith({ n: 2 });
});

test("an EMPTY inject record still hands the factory a record, not nothing", async () => {
  // Every provider is handed exactly one services record, so a caller who
  // wrote `inject: {}` gets `{}` — not the `undefined` a key count would hand
  // them.
  const p = Provider(Value)({
    inject: {},
    sync: (services) => ({ n: Object.keys(services).length }),
  });
  await expect(p.construct([])).resolves.toBeOkWith({ n: 0 });
});

test("a make provider propagates the Err it returns", async () => {
  const p = Provider(Value)({ inject: {}, make: () => Err(new BoomError({ why: "nope" })) });
  await expect(p.construct([])).resolves.toBeErrTagged("BoomError");
});

test("a throw inside a factory becomes a defect, not an error", async () => {
  const p = Provider(Value)({
    inject: {},
    sync: () => {
      // Deliberate: this is exactly the case under test — an unmodeled throw
      // from a factory must land as a Defect, not propagate or become an Err.
      // oxlint-disable-next-line unthrown/no-throw
      throw new Error("kaboom");
    },
  });
  await expect(p.construct([])).resolves.toBeDefect();
});

test("a class provider constructs with the resolved dependencies", async () => {
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
  const built = await p.construct([41]);
  expect(built.isOk() && (built.value as Impl).n).toBe(42);
});

test("an Ok result from make is passed through unchanged", async () => {
  const p = Provider(Value)({ inject: {}, make: () => Ok({ n: 3 }) });
  await expect(p.construct([])).resolves.toBeOkWith({ n: 3 });
});
