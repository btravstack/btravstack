import { Ok } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("the unit module", () => {
  it("is forked per unit over a parent built once", async ({ unitApp }) => {
    // GIVEN a serving application whose StartOptions carry a unit module
    const { runtime, counts } = unitApp;

    // WHEN two units run to completion
    const first = runtime.submit<string>();
    first.settle(Ok("a"));
    (await first.result).get();
    const second = runtime.submit<string>();
    second.settle(Ok("b"));
    (await second.result).get();

    // THEN the unit provider was built and torn down once per unit, while the
    // application-scoped parent it reads was constructed exactly once — the
    // fork seeds the parent's services, it does not rebuild them
    expect(counts).toEqual({ parentBuilds: 1, spanBuilds: 2, spanStops: 2 });
  });

  it("builds and tears down inside the unit's own ambient record", async ({ unitApp }) => {
    // GIVEN a serving application whose StartOptions carry a unit module
    const { runtime, seen } = unitApp;

    // WHEN one unit runs to completion
    const unit = runtime.submit<string>();
    unit.settle(Ok("x"));
    (await unit.result).get();

    // THEN both the provider's build and its onStop observed currentUnit(),
    // and observed the SAME unit — teardown happens while the unit is still
    // open, which is what gives a teardown log line the request's trace id
    expect(seen).toEqual({ build: expect.any(String), stop: seen.build });
  });
});
