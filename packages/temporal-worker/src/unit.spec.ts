import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { unitsOf, withFork } from "./unit.js";

describe("unitsOf", () => {
  it("lists a module several pieces fork once, under its own name, beside the worker-wide one", () => {
    // GIVEN two pieces naming one module, and a worker-wide module
    const shared = Module("Shared")({});
    const worker = Module("Worker")({});
    const activities = { a: withFork(() => {}, shared), b: withFork({}, shared), c: () => {} };

    // WHEN the runtime's units record is built
    const units = unitsOf(worker, activities);

    // THEN each module appears once, keyed where an override would name it
    expect(units).toEqual({ activity: worker, Shared: shared });
  });

  it("lists a module named after an Object.prototype member as its own entry", () => {
    // GIVEN one piece forking a module named like an inherited property
    const named = Module("constructor")({});
    const activities = { a: withFork(() => {}, named) };

    // WHEN the runtime's units record is built
    const units = unitsOf(undefined, activities);

    // THEN it is listed, not refused as a duplicate of the inherited member
    expect(Object.entries(units)).toEqual([
      ["activity", undefined],
      ["constructor", named],
    ]);
  });

  it("refuses two different modules sharing a name, which an override could not tell apart", () => {
    // GIVEN two pieces naming two modules called the same
    const activities = {
      a: withFork(() => {}, Module("Twin")({})),
      b: withFork(() => {}, Module("Twin")({})),
    };

    // WHEN / THEN building the units record refuses them, naming the module
    expect(() => unitsOf(undefined, activities)).toThrow('two unit modules named "Twin"');
  });
});
