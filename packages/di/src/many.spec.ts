import { expect, test, vi } from "vitest";

import { Module, Port, Provider } from "./index.js";

class Db extends Port("MyDb")<{ readonly name: string }> {}
class HealthChecks extends Port.many("MyHealthChecks")<{
  readonly check: () => string;
}> {}

test("contributions accumulate across module boundaries", async () => {
  const dbModule = Module("Db")({
    provides: [
      Provider(Db)({ value: { name: "pg" } }),
      Provider.member(HealthChecks)([Db], { sync: (db) => ({ check: () => db.name }) }),
    ],
    exports: [Db, HealthChecks],
  });
  const cacheModule = Module("Cache")({
    provides: [Provider.member(HealthChecks)({ value: { check: () => "redis" } })],
    exports: [HealthChecks],
  });
  const app = Module("App")({
    imports: [dbModule, cacheModule],
    exports: [dbModule, cacheModule],
  });

  const built = await Module.build(app);
  expect(
    built.isOk() &&
      built.value
        .get(HealthChecks)
        .map((h) => h.check())
        .toSorted(),
  ).toEqual(["pg", "redis"]);
});

test("several members of one set port are not a collision", async () => {
  const mod = Module("Many")({
    provides: [
      Provider.member(HealthChecks)({ value: { check: () => "a" } }),
      Provider.member(HealthChecks)({ value: { check: () => "b" } }),
    ],
    exports: [HealthChecks],
  });
  await expect(Module.build(mod)).resolves.toBeOk();
});

// The brief's two tests above only prove the happy path for a set port in
// isolation. Neither shows the exemption is actually *keyed* on `many ===
// true` rather than on, say, shape or naming convention — the two tests
// below guard that: one port pair shares a service shape but differs only
// in "many", and a plain ordinary port still rejects a second provider
// after the exemption landed.
class SingleCheck extends Port("MySingleCheck")<{ readonly check: () => string }> {}
class ManyCheck extends Port.many("MyManyCheck")<{ readonly check: () => string }> {}

test("a set port and an ordinary port of the same service shape do not interfere", async () => {
  const mod = Module("Mixed")({
    provides: [
      Provider(SingleCheck)({ value: { check: () => "single" } }),
      Provider.member(ManyCheck)({ value: { check: () => "many-a" } }),
      Provider.member(ManyCheck)({ value: { check: () => "many-b" } }),
    ],
    exports: [SingleCheck, ManyCheck],
  });
  const built = await Module.build(mod);
  expect(built.isOk() && built.value.get(SingleCheck).check()).toBe("single");
  expect(
    built.isOk() &&
      built.value
        .get(ManyCheck)
        .map((h) => h.check())
        .toSorted(),
  ).toEqual(["many-a", "many-b"]);
});

test("two providers for an ordinary port are still a defect after the many-port exemption", async () => {
  const dup = Module("StillDup")({
    provides: [
      Provider(SingleCheck)({ value: { check: () => "a" } }),
      Provider(SingleCheck)({ value: { check: () => "b" } }),
    ],
    exports: [SingleCheck],
  });
  const built = await Module.build(dup);
  expect(built).toBeDefect();
});

// Regression test for a review finding: nothing stopped one portId from being
// declared both an ordinary port (by one class) and a set port (by another),
// and left unchecked the ordinary provider's later-arriving `continue` (if
// declared after the set-port one) or silent overwrite (if declared before
// it) meant the mismatch was never reported as the wiring bug it is —
// `unsafeAddAll` (`context.ts`) would instead try to spread a single,
// non-iterable service as though it were a set port's member array, and the
// resulting `TypeError` defect said nothing about the real cause. `plan`
// (`build.ts`) now checks every provider's `many`-ness against whatever it
// has already seen for that portId and throws a clear `WiringDefect` the
// moment they disagree — before any factory runs, same as every other
// wiring check.
test("a portId used as both a set port and an ordinary port is a clear wiring defect", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  class MixedOrdinary extends Port("MDMixedId")<{ readonly check: () => string }> {}
  class MixedMany extends Port.many("MDMixedId")<{ readonly check: () => string }> {}

  const mod = Module("MixedId")({
    provides: [
      Provider(MixedOrdinary)({ value: { check: () => "ordinary" } }),
      Provider.member(MixedMany)({ value: { check: () => "member" } }),
    ],
    exports: [MixedOrdinary],
  });
  const built = await Module.build(mod);
  expect(built).toBeDefect();
  // Not merely "some defect" — the *clear* WiringDefect, not the misleading
  // spread-a-non-iterable TypeError the old, unchecked code path produced.
  expect(built.isDefect() && built.cause).toBeInstanceOf(Error);
  expect(built.isDefect() && (built.cause as Error).message).toBe(
    '[di] port "MDMixedId" is registered as both a set port and an ordinary port',
  );

  warn.mockRestore();
});
