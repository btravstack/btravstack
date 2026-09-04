import { Ok } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

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

  it("reports a failing unit teardown as an event and keeps it off the exit report", async ({
    unitApp,
  }) => {
    // GIVEN a unit whose teardown fails
    const { runtime, app, events, failTeardown } = unitApp;
    failTeardown(new Error("stop-boom"));
    const unit = runtime.submit<string>();
    unit.settle(Ok("x"));
    (await unit.result).get();

    // WHEN the application exits
    app.stop();

    // THEN the failure reached the event sink under the unit provider's port,
    // and the exit report's `teardownErrors` — the application scope's — is
    // untouched: a per-unit finaliser failing on every request must not grow it
    await expect(
      app.exited.map((report) => ({
        teardownErrors: report.teardownErrors,
        reported: events.filter((event) => event.type === "teardownError"),
      })),
    ).toBeOkWith({
      teardownErrors: [],
      reported: [
        {
          type: "teardownError",
          port: "UnitFixtureSpan",
          cause: expect.objectContaining({ message: "stop-boom" }),
        },
      ],
    });
  });

  it("keeps a unit in flight until its scope has closed", async ({ unitApp }) => {
    // GIVEN a unit whose work has settled but whose teardown is held open
    const { runtime, app, holdTeardown } = unitApp;
    const { release } = holdTeardown();
    const unit = runtime.submit<string>();
    unit.settle(Ok("x"));

    // WHEN a drain begins in that state, and the teardown is released only once
    // the drain is waiting on the registry
    app.requestDrain();
    await vi.waitUntil(() => !runtime.accepting());
    release();

    // THEN the drain counted the unit as still in flight when it started, and as
    // completed rather than abandoned once the scope closed — the unit is not
    // closed until its teardown is, so a drain waits for request-scoped
    // finalisers too
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  it("reports a second fork in one unit as a defect", async ({ unitApp }) => {
    // GIVEN a runtime whose unit work forks the module twice
    const { runtime, forkTwice } = unitApp;
    const unit = runtime.submit<string>();
    unit.settle(Ok("x"));
    await unit.result;
    const twice = forkTwice();

    // WHEN the second fork is attempted inside one unit
    // THEN it lands on the defect path rather than opening a second scope
    await expect(twice).toBeDefectWith(
      expect.objectContaining({ message: "a unit forks its scope once" }),
    );
  });

  it("recovers a fork's construction failure onto the caller's defect path", async ({
    unitApp,
  }) => {
    // GIVEN a runtime whose unit work forks a module that fails to construct
    const { forkBroken } = unitApp;
    const broken = forkBroken();

    // WHEN the fork is attempted
    // THEN the caller lands on the defect path instead of waiting forever
    await expect(broken).toBeDefectWith(expect.objectContaining({ message: "construction-boom" }));
  });
});
