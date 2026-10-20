import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { queryObserver } from "./instrument.js";

describe("queryObserver", () => {
  const contexts = new Map<string, Map<string | symbol, Record<string | symbol, unknown>>>();
  const ctx = (id: string, scope?: "runtime" | "transaction") => ({
    ...(scope === undefined ? {} : { scope }),
    state: (key: string | symbol) => {
      let context = contexts.get(id);
      if (context === undefined) {
        context = new Map();
        contexts.set(id, context);
      }
      let state = context.get(key);
      if (state === undefined) {
        state = {};
        context.set(key, state);
      }
      return state;
    },
  });

  it("spans the query rather than reporting it after the fact", async ({ observed }) => {
    // GIVEN the starter's middleware over a recording observer
    const hook = queryObserver(observed.members);

    // WHEN a query runs: started before the driver, settled after
    await hook.beforeEncode({ sql: "SELECT 1" }, ctx("a", "transaction"));
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "succeeded", source: "driver" },
      ctx("a"),
    );

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
    await hook.beforeEncode({ sql: "INSERT …" }, ctx("b"));

    // WHEN it does not complete — measured against a real database, a duplicate
    // insert reaches the hook this way before the rejection surfaces
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "failed" },
      ctx("b"),
    );

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
    await hook.beforeEncode({ sql: "DELETE FROM …" }, ctx("c"));
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "succeeded" },
      ctx("c"),
    );

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
    await hook.beforeEncode({ sql: "first" }, ctx("one"));
    await hook.beforeEncode({ sql: "second" }, ctx("two"));

    // WHEN they settle out of order, one failing
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "failed" },
      ctx("two"),
    );
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "succeeded" },
      ctx("one"),
    );

    // THEN each settled its OWN operation: the activity context is what pairs a
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
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "succeeded" },
      ctx("unknown"),
    );

    // THEN nothing is reported, rather than an operation with no beginning
    expect(observed.taken()).toEqual([]);
  });

  it("does not count transaction activities as statements", async ({ observed }) => {
    // GIVEN a middleware receiving a transaction activity
    const hook = queryObserver(observed.members);

    // WHEN the transaction ends
    await hook.activityEnded({ kind: "transaction" }, { kind: "transaction" }, ctx("transaction"));

    // THEN no query was reported
    expect(observed.taken()).toEqual([]);
  });

  it("settles a statement whose reader stopped early", async ({ observed }) => {
    // GIVEN a statement whose result is still being read
    const hook = queryObserver(observed.members);
    await hook.beforeEncode({ sql: "SELECT …" }, ctx("stopped"));

    // WHEN the reader stops without exhausting it
    await hook.activityEnded(
      { kind: "statement" },
      { kind: "statement", outcome: "stopped", source: "driver" },
      ctx("stopped"),
    );

    // THEN its operation is closed as an unsuccessful read
    expect(observed.taken()).toEqual([
      expect.objectContaining({
        outcome: "error",
        attributes: { scope: "runtime", source: "driver" },
      }),
    ]);
  });

  it("spans a query through the rc.11 hooks, paired by the operation's context", async ({
    observed,
  }) => {
    // GIVEN the same middleware, run by a Prisma rc.11 to rc.17 runtime, which
    // hands every hook of one statement the same context object
    const hook = queryObserver(observed.members);
    const statement = { scope: "transaction" } as const;

    // WHEN a query runs through the hooks that runtime calls
    await hook.beforeQuery({ sql: "SELECT 1" }, statement);
    await hook.afterQuery({}, { completed: true, source: "driver" }, statement);

    // THEN it is observed exactly as the rc.18 hooks observe it
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

  it("settles an rc.11 write that did not complete as an error", async ({ observed }) => {
    // GIVEN a write in flight on the rc.11 execute lane
    const hook = queryObserver(observed.members);
    const statement = {};
    await hook.beforeExecute({ sql: "DELETE FROM …" }, statement);

    // WHEN it does not complete
    await hook.afterExecute({}, { completed: false }, statement);

    // THEN its outcome is an error, on the lane a query-only middleware misses
    expect(observed.taken()).toEqual([
      expect.objectContaining({
        outcome: "error",
        attributes: { scope: "runtime" },
        details: { sql: "DELETE FROM …" },
      }),
    ]);
  });

  it("keeps two rc.11 statements in flight apart, and forgets each once settled", async ({
    observed,
  }) => {
    // GIVEN two overlapping rc.11 statements
    const hook = queryObserver(observed.members);
    const one = {};
    const two = {};
    await hook.beforeQuery({ sql: "first" }, one);
    await hook.beforeQuery({ sql: "second" }, two);

    // WHEN they settle out of order, and the first one's `after` arrives twice
    await hook.afterQuery({}, { completed: false }, two);
    await hook.afterQuery({}, { completed: true }, one);
    await hook.afterQuery({}, { completed: true }, one);

    // THEN each settled its own operation once
    expect(observed.taken()).toEqual([
      expect.objectContaining({ details: { sql: "second" }, outcome: "error" }),
      expect.objectContaining({ details: { sql: "first" }, outcome: "ok" }),
    ]);
  });
});
