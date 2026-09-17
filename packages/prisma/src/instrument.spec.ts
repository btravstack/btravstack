import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { queryObserver } from "./instrument.js";

describe("queryObserver", () => {
  it("settles a completed query ok, carrying the runtime's own latency", async ({ observed }) => {
    // GIVEN the starter's middleware over a recording observer
    const hook = queryObserver(observed.members);

    // WHEN a query completes
    await hook.afterQuery(
      {},
      { completed: true, rowCount: 3, latencyMs: 12, source: "driver" },
      {},
    );

    // THEN one operation was reported, dimensioned by what the runtime measured
    expect(observed.taken()).toEqual([
      {
        component: "database",
        name: "query",
        attributes: { rows: 3, latencyMs: 12, source: "driver" },
        outcome: "ok",
        failed: false,
        traced: true,
      },
    ]);
  });

  it("settles a failed query as an error, which is what keeps RED honest", async ({ observed }) => {
    // GIVEN the same middleware
    const hook = queryObserver(observed.members);

    // WHEN a query does not complete — the hook still runs
    await hook.afterQuery({}, { completed: false, rowCount: 0 }, {});

    // THEN the outcome says so: a failed query counted beside the successes is
    // the one an operator most needs to see
    expect(observed.taken()).toEqual([
      expect.objectContaining({ outcome: "error", attributes: { rows: 0 } }),
    ]);
  });

  it("reports a query the runtime measured nothing about", async ({ observed }) => {
    // GIVEN a result carrying neither latency nor source, which the hook's own
    // type admits
    const hook = queryObserver(observed.members);

    // WHEN it settles
    await hook.afterQuery({}, { completed: true }, {});

    // THEN the absent dimensions are absent rather than `undefined` — an
    // attribute whose value is nothing is a time series nobody can read
    expect(observed.taken()).toEqual([expect.objectContaining({ attributes: { rows: 0 } })]);
  });
});
