import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { queryObserver } from "./instrument.js";

const ctx = (id: string, scope?: "runtime" | "transaction") => ({
  planExecutionId: id,
  ...(scope === undefined ? {} : { scope }),
});

describe("queryObserver", () => {
  it("spans the query rather than reporting it after the fact", async ({ observed }) => {
    // GIVEN the starter's middleware over a recording observer
    const hook = queryObserver(observed.members);

    // WHEN a query runs: started before the driver, settled after
    await hook.beforeQuery({ sql: "SELECT 1" }, ctx("a", "transaction"));
    await hook.afterQuery({}, { completed: true, source: "driver" }, ctx("a"));

    // THEN the operation was OPEN across the query, which is what lets an
    // observer put a span around it — and the statement rides `details`, where
    // an unbounded value belongs, while the bounded pair are attributes
    expect(observed.taken()).toEqual([
      {
        component: "database",
        name: "query",
        attributes: { scope: "transaction", source: "driver" },
        details: { sql: "SELECT 1" },
        outcome: "ok",
        failed: false,
        traced: true,
      },
    ]);
  });

  it("settles a failed query as an error, which is what keeps RED honest", async ({ observed }) => {
    // GIVEN a query in flight
    const hook = queryObserver(observed.members);
    await hook.beforeQuery({ sql: "INSERT …" }, ctx("b"));

    // WHEN it does not complete — measured against a real database, a duplicate
    // insert reaches the hook this way before the rejection surfaces
    await hook.afterQuery({}, { completed: false }, ctx("b"));

    // THEN the outcome says so: a failed query counted beside the successes is
    // the one an operator most needs to see
    expect(observed.taken()).toEqual([
      expect.objectContaining({ outcome: "error", attributes: { scope: "runtime" } }),
    ]);
  });

  it("observes the WRITE lane too, which has hooks of its own", async ({ observed }) => {
    // GIVEN a statement with no `RETURNING` — a SQL-builder `delete()` run
    // through `runtime().execute(plan)`
    const hook = queryObserver(observed.members);

    // WHEN it runs
    await hook.beforeExecute({ sql: "DELETE FROM …" }, ctx("c"));
    await hook.afterExecute({}, { completed: true }, ctx("c"));

    // THEN it is observed. Implementing only the query hooks would leave every
    // non-returning write invisible, which is the half a RED dashboard would
    // never notice was missing
    expect(observed.taken()).toEqual([
      expect.objectContaining({ outcome: "ok", details: { sql: "DELETE FROM …" } }),
    ]);
  });

  it("keeps two statements in flight apart, by the runtime's own id", async ({ observed }) => {
    // GIVEN two overlapping statements
    const hook = queryObserver(observed.members);
    await hook.beforeQuery({ sql: "first" }, ctx("one"));
    await hook.beforeQuery({ sql: "second" }, ctx("two"));

    // WHEN they settle out of order, one failing
    await hook.afterQuery({}, { completed: false }, ctx("two"));
    await hook.afterQuery({}, { completed: true }, ctx("one"));

    // THEN each settled its OWN operation: `planExecutionId` is what pairs a
    // `before` with its `after`, and a single pending slot would have crossed
    // the outcomes
    expect(observed.taken()).toEqual([
      expect.objectContaining({ details: { sql: "second" }, outcome: "error" }),
      expect.objectContaining({ details: { sql: "first" }, outcome: "ok" }),
    ]);
  });

  it("ignores an `after` for a statement it never saw start", async ({ observed }) => {
    // GIVEN a middleware added to a client mid-flight, so an `after` arrives
    // with no `before` behind it
    const hook = queryObserver(observed.members);

    // WHEN that `after` runs
    await hook.afterQuery({}, { completed: true }, ctx("unknown"));

    // THEN nothing is reported, rather than an operation with no beginning
    expect(observed.taken()).toEqual([]);
  });
});
