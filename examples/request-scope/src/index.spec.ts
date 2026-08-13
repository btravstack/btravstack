import { Module } from "@btravstack/di";
// Side-effect import for `tsc`'s benefit only — see the identical note in
// hexagonal-order-api's `index.spec.ts`.
import "@unthrown/vitest";
import { Ok } from "unthrown";
import { expect, test } from "vitest";

import { type LifecycleEvent, handleRequest, makeAppModule } from "./index.js";

test("each request's transaction releases before the next begins, and the pool survives every one", async () => {
  const events: LifecycleEvent[] = [];
  const onEvent = (event: LifecycleEvent) => void events.push(event);

  const outcome = await Module.scoped(makeAppModule(onEvent), (appCtx) =>
    handleRequest(appCtx, onEvent, (txn) => Ok(txn.run("req-1")).toAsync())
      // Checkpoint after the first request unwinds: its own transaction has
      // already released, and — critically — "pool-released" has not
      // appeared yet, proving the parent stayed up across the fork's own
      // teardown.
      .tap(() => {
        expect(events.at(-1)).toBe("txn-released");
        expect(events).not.toContain("pool-released");
      })
      .flatMap(() =>
        handleRequest(appCtx, onEvent, (txn) => Ok(txn.run("req-2")).toAsync())
          // Same checkpoint after a second, sibling fork over the same
          // parent — the parent survives more than just the first fork.
          .tap(() => {
            expect(events.at(-1)).toBe("txn-released");
            expect(events).not.toContain("pool-released");
          }),
      )
      .flatMap(() =>
        handleRequest(appCtx, onEvent, (txn) => Ok(txn.run("req-3")).toAsync()).tap(() => {
          expect(events.at(-1)).toBe("txn-released");
          expect(events).not.toContain("pool-released");
        }),
      ),
  );

  expect(outcome).toBeOk();
  // The full timeline: the pool opens once, before anything else, and
  // closes once, after every request's transaction has already released —
  // last, not merely present.
  expect(events).toEqual([
    "pool-acquired",
    "txn-acquired",
    "txn-released",
    "txn-acquired",
    "txn-released",
    "txn-acquired",
    "txn-released",
    "pool-released",
  ]);
});

test("a fork resolves its dependency from the parent, not a copy of its own", async () => {
  const events: LifecycleEvent[] = [];
  const onEvent = (event: LifecycleEvent) => void events.push(event);

  const outcome = await Module.scoped(makeAppModule(onEvent), (appCtx) =>
    handleRequest(appCtx, onEvent, (txn) => Ok(txn.run("a")).toAsync()).flatMap((first) =>
      handleRequest(appCtx, onEvent, (txn) => Ok(txn.run("b")).toAsync()).map(
        (second) => [first, second] as const,
      ),
    ),
  );

  expect(outcome).toBeOk();
  const [first, second] = outcome.isOk() ? outcome.value : ["", ""];
  // Both requests' transactions ran their query through the *same*
  // connection lineage — `handleRequest`'s fork read `ConnectionPool` off
  // the parent `appCtx`, not off a fresh copy of its own.
  const poolIdOf = (label: string) => label.split("/")[0];
  expect(poolIdOf(first)).toBe(poolIdOf(second));
});
