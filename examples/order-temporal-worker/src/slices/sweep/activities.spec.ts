import { describe, expect } from "vitest";

import { it } from "../../__tests__/test-fixtures.js";
import { withdrawStale } from "./activities.js";

describe("withdrawStale", () => {
  it("removes every stale order, batch after batch, until none is left", async ({ staleStore }) => {
    // GIVEN two stale orders and a unit nobody has aborted
    const signal = new AbortController().signal;

    // WHEN the sweep runs over them
    const outcome = await withdrawStale(staleStore.repository, new Date(), signal);

    // THEN both were removed and the sweep came back
    expect({ ok: outcome.isOk(), removed: staleStore.removed() }).toEqual({
      ok: true,
      removed: ["0199a1e0-0000-7000-8000-00000000d001", "0199a1e0-0000-7000-8000-00000000d002"],
    });
  });

  it("deletes nothing once its unit's deadline has passed, and fails as a defect", async ({
    staleStore,
  }) => {
    // GIVEN a unit the kernel has already stopped waiting for
    const abort = new AbortController();
    abort.abort();

    // WHEN the sweep is started under it
    const outcome = await withdrawStale(staleStore.repository, new Date(), abort.signal);

    // THEN it removed nothing, and the attempt is a defect Temporal retries
    // elsewhere rather than a sweep this process kept running
    expect({ defect: outcome.isDefect(), removed: staleStore.removed() }).toEqual({
      defect: true,
      removed: [],
    });
  });

  it("leaves an order placed again under a listed id between the listing and the removal", async ({
    racedStore,
  }) => {
    // GIVEN two stale orders, the first of which is compensated away and
    // placed again — freshly — once the sweep has listed it
    const signal = new AbortController().signal;

    // WHEN the sweep runs
    const outcome = await withdrawStale(racedStore.repository, new Date(), signal);

    // THEN the fresh order survives and no tombstone was written for it: the
    // removal re-checked the cutoff in the store, not in the listing
    expect({
      ok: outcome.isOk(),
      removed: racedStore.removed(),
      held: racedStore.held(),
    }).toEqual({
      ok: true,
      removed: ["0199a1e0-0000-7000-8000-00000000d002"],
      held: ["0199a1e0-0000-7000-8000-00000000d001"],
    });
  });
});
