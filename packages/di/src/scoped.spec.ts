import { Err, ErrAsync, Ok, OkAsync, TaggedError } from "unthrown";
import { expect, test, vi } from "vitest";

import { Module, Port, Provider, type AnyPort } from "./index.js";
// Deliberately not from `./index.js`: the package deliberately exports `Scope`
// as a type only, so the class *value* these two defect tests need is not on
// the public surface at all. Importing it straight from the module that
// declares it is what lets them keep proving `plan()`'s runtime `portId`
// check fires — the defence in depth behind the type-only export.
import { Scope } from "./port.js";
import { createScope } from "./scope.js";

class OpenError extends TaggedError("OpenError")<{ readonly which: string }> {}

class First extends Port("SFirst")<{ readonly n: 1 }> {}
class Second extends Port("SSecond")<{ readonly n: 2 }> {}

test("resources release in reverse acquisition order after use", async () => {
  // GIVEN
  const released: string[] = [];
  const mod = Module("Two")({
    provides: [
      Provider(First)({
        inject: {},
        acquire: () => Ok({ n: 1 as const }),
        release: () => void released.push("first"),
      }),
      Provider(Second)({
        inject: { first: First },
        acquire: () => Ok({ n: 2 as const }),
        release: () => void released.push("second"),
      }),
    ],
    exports: [First, Second],
  });

  // WHEN
  await Module.scoped(mod, () => OkAsync("done"));
  // THEN
  expect(released).toEqual(["second", "first"]);
});

test("a mid-graph failure releases everything already acquired", async () => {
  // GIVEN
  const released: string[] = [];
  const mod = Module("Failing")({
    provides: [
      Provider(First)({
        inject: {},
        acquire: () => Ok({ n: 1 as const }),
        release: () => void released.push("first"),
      }),
      Provider(Second)({
        inject: { first: First }, // `acquire` (not `make`) on purpose: `Second` has a `release`, so this
        // exercises the real guarantee — a failed *acquire* never registers its
        // own release (the `.tap` in `constructLevel` only fires on `Ok`) — not
        // just "a provider with no `release` field has nothing to release".
        acquire: () => Err(new OpenError({ which: "second" })),
        release: () => void released.push("second"),
      }),
    ],
    exports: [First, Second],
  });

  // WHEN
  const result = await Module.scoped(mod, () => OkAsync("unreachable"));
  // THEN
  expect(result).toBeErrTagged("OpenError");
  expect(released).toEqual(["first"]);
});

test("a rejecting release neither masks the failure nor stops the unwind", async () => {
  // GIVEN
  const released: string[] = [];
  const onTeardownError = vi.fn();
  const mod = Module("BadRelease")({
    provides: [
      Provider(First)({
        inject: {},
        acquire: () => Ok({ n: 1 as const }),
        release: () => void released.push("first"),
      }),
      Provider(Second)({
        inject: { first: First },
        acquire: () => Ok({ n: 2 as const }),
        release: () => Promise.reject(new Error("close failed")),
      }),
    ],
    exports: [First, Second],
  });

  // WHEN
  const result = await Module.scoped(mod, () => ErrAsync(new OpenError({ which: "use" })), {
    onTeardownError,
  });

  // THEN
  expect(result).toBeErrTagged("OpenError");
  expect(released).toEqual(["first"]);
  expect(onTeardownError).toHaveBeenCalledWith("SSecond", expect.any(Error));
});

test("a throwing onTeardownError does not abandon the unwind or mask the original failure", async () => {
  // GIVEN
  const released: string[] = [];
  // A reporter that itself throws — the failure mode a rejecting release
  // already covers is "the thing being reported fails"; this covers "the
  // reporting itself fails," which must not propagate: there is nowhere
  // left to report a broken reporter to, and the `for` loop in `close()`
  // must still reach `First`'s release after `Second`'s throws here.
  const onTeardownError = vi.fn(() => {
    // Deliberate: this test exists specifically to prove `createScope`
    // survives a throwing reporter, so the reporter has to actually throw.
    // oxlint-disable-next-line unthrown/no-throw
    throw new Error("reporter itself is broken");
  });
  const openError = new OpenError({ which: "use" });
  const mod = Module("BadReporter")({
    provides: [
      Provider(First)({
        inject: {},
        acquire: () => Ok({ n: 1 as const }),
        release: () => void released.push("first"),
      }),
      Provider(Second)({
        inject: { first: First },
        acquire: () => Ok({ n: 2 as const }),
        release: () => Promise.reject(new Error("close failed")),
      }),
    ],
    exports: [First, Second],
  });

  // WHEN
  const result = await Module.scoped(mod, () => ErrAsync(openError), {
    onTeardownError,
  });

  // THEN
  // Not just `toBeErrTagged`: identity, not merely shape, proves the
  // reporter's own throw never got laundered into the result (e.g. as a
  // `Defect` replacing the original `Err`).
  expect(result.isErr() && result.error).toBe(openError);
  // `First` still released — the reporter's throw on `Second`'s failed
  // release did not abandon the rest of the reverse-order loop.
  expect(released).toEqual(["first"]);
  expect(onTeardownError).toHaveBeenCalledWith("SSecond", expect.any(Error));
});

test("Scope is not on the package's runtime export surface", async () => {
  // GIVEN
  // The first line of defence behind the two defect tests below: consumers
  // need `Scope` only in type positions, so the class value is withheld from
  // `index.ts` (`export type { Scope }`). Asserted on the real module
  // namespace rather than by a type-level check, because a type-only export
  // is precisely one that leaves no trace in the type of the import — the
  // erasure *is* the property under test, and only the runtime surface can
  // observe it. If someone re-adds `Scope` to the value exports, this fails.
  // WHEN its runtime namespace is read
  const index: Record<string, unknown> = await import("./index.js");
  // THEN
  expect(Object.keys(index)).not.toContain("Scope");
  // Control: the value exports that are supposed to be there still are, so
  // this cannot pass by the import silently resolving to nothing.
  expect(Object.keys(index)).toEqual(
    expect.arrayContaining(["Port", "Context", "Provider", "Module"]),
  );
});

test("providing Scope directly is a wiring defect, not a satisfied dependency", async () => {
  // GIVEN
  const ran = vi.fn();
  const mod = Module("ProvidesScopeDirect")({
    // `Scope`'s own service shape is `never`, so nothing can genuinely
    // construct one — this factory would never legitimately run; the test
    // is about `plan()` rejecting the registration itself, before any
    // factory (including this one) is called at all.
    provides: [Provider(Scope)({ inject: {}, sync: ran as never })],
  });

  // WHEN
  const built = await Module.build(mod);
  // THEN
  expect(built).toBeDefect();
  expect(ran).not.toHaveBeenCalled();
});

test("providing Scope through a widened AnyPort alias is still a wiring defect", async () => {
  // GIVEN
  // The bypass a type-level guard on `Provider`'s own port parameter could
  // not catch: one widening annotation erases which concrete port class
  // `widened` statically is, so any conditional keyed on that static type
  // sees only the structural `AnyPort` shape and cannot single `Scope` back
  // out. `plan()`'s check is sound against exactly this, because it reads
  // the *runtime* `portId` off the registered provider, not a static type.
  const widened: AnyPort = Scope;
  const ran = vi.fn();
  const mod = Module("ProvidesScopeWidened")({
    provides: [Provider(widened)({ inject: {}, sync: ran as never })],
  });

  // WHEN
  const built = await Module.build(mod);
  // THEN
  expect(built).toBeDefect();
  expect(ran).not.toHaveBeenCalled();
});

// `createScope`'s default reporter. Every other test supplies one, so the
// fallback — the only thing standing between a failed finaliser and silence —
// was never exercised.
test("reports a failed finaliser on the console when no reporter is given", async () => {
  // GIVEN
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const scope = createScope();
  const cause = new Error("finaliser blew up");
  scope.onStop("Doomed", () => Promise.reject(cause));

  // WHEN
  await scope.close();

  // THEN
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("finaliser for Doomed failed during close"),
    cause,
  );
  error.mockRestore();
});
