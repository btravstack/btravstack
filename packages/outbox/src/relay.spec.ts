import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { fromSafePromise } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

const order = (tenantId: string, subjectId: string) => ({
  tenantId,
  kind: "order",
  subjectId,
  payload: "{}",
});

describe("outbox", () => {
  it("publishes every pending message in outbox order, and marks each published", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN three facts committed for one tenant
    for (const id of ["a", "b", "c"]) store.append(order("acme", id));

    // WHEN the relay has had its first sweep
    const swept = await relaying({ tenants: ["acme"] }, () =>
      clock
        .advance(0)
        .flatMap(() => store.pending("acme", 10))
        .map((pending) => ({ sent: publisher.sent(), pending })),
    );

    // THEN they went out in the order they were written, and none is left
    expect(swept).toBeOkWith({ sent: ["a", "b", "c"], pending: [] });
  });

  it("stops a tenant's batch at the first refusal, so nothing overtakes it", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN three facts, the second of which the transport refuses
    for (const id of ["a", "b", "c"]) store.append(order("acme", id));
    publisher.refuse("b");

    // WHEN the relay sweeps
    const swept = await relaying({ tenants: ["acme"] }, () =>
      clock
        .advance(0)
        .flatMap(() => store.pending("acme", 10))
        .map((pending) => ({ sent: publisher.sent(), pending: pending.map((m) => m.subjectId) })),
    );

    // THEN the first went out and the rest wait behind the refused one
    expect(swept).toBeOkWith({ sent: ["a"], pending: ["b", "c"] });
  });

  it("retries a refused message after backing off, doubling from the poll interval", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a fact the transport refuses once
    store.append(order("acme", "a"));
    publisher.refuse("a", 1);

    // WHEN one poll interval passes, and then a second
    const swept = await relaying({ tenants: ["acme"], pollMs: 100 }, () =>
      clock
        .advance(100)
        .map(() => [...publisher.sent()])
        .flatMap((early) => clock.advance(100).map(() => ({ early, late: publisher.sent() }))),
    );

    // THEN the retry waited twice the interval, not once
    expect(swept).toBeOkWith({ early: [], late: ["a"] });
  });

  it("delivers a placement refused once before the deletion behind it, on the next sweep", async ({
    store,
    publisher,
    clock,
    observations,
    relaying,
  }) => {
    // GIVEN an order's placement and then its tombstone, the placement refused once
    store.append(order("acme", "o-1"));
    store.append({ ...order("acme", "o-1"), payload: null });
    publisher.refuse("o-1", 1);
    const marked: number[] = [];
    const marking = {
      ...store,
      claim: (...[tenantId, limit, relay]: Parameters<typeof store.claim>) =>
        store.claim(tenantId, limit, (batch) =>
          relay(batch).tap((ids) => {
            marked.push(...ids);
          }),
        ),
    };

    // WHEN the relay sweeps, backs off, and sweeps again
    const swept = await relaying(
      { tenants: ["acme"], pollMs: 100 },
      () =>
        clock.advance(200).map(() => ({
          publishes: observations
            .filter((o) => o.name === "publish")
            .map((o) => ({ id: o.details["btravstack.outbox.id"], outcome: o.outcome })),
          marked,
        })),
      marking,
    );

    // THEN the tombstone was never tried before its placement, and both were marked in order
    expect(swept).toBeOkWith({
      publishes: [
        { id: 1, outcome: "error" },
        { id: 1, outcome: "ok" },
        { id: 2, outcome: "ok" },
      ],
      marked: [1, 2],
    });
  });

  it("sweeps again at once while a batch comes back full", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a backlog longer than one batch
    const ids = Array.from({ length: 40 }, (_, index) => `m-${String(index)}`);
    for (const id of ids) store.append(order("acme", id));

    // WHEN the relay starts, and no time passes
    const swept = await relaying({ tenants: ["acme"] }, () =>
      clock.advance(0).map(() => publisher.sent()),
    );

    // THEN the whole backlog went out without waiting for a poll
    expect(swept).toBeOkWith(ids);
  });

  it("keeps one tenant's refusal from holding another's facts", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a stuck fact for one tenant and a ready one for another
    store.append(order("acme", "stuck"));
    store.append(order("globex", "ready"));
    publisher.refuse("stuck");

    // WHEN the relay sweeps both
    const swept = await relaying({ tenants: ["acme", "globex"] }, () =>
      clock.advance(0).map(() => publisher.sent()),
    );

    // THEN the second tenant's fact went out regardless
    expect(swept).toBeOkWith(["ready"]);
  });

  it("publishes another tenant while the first tenant's publisher is pending", async ({
    store,
    publisher,
    relaying,
  }) => {
    store.append(order("acme", "stuck"));
    store.append(order("globex", "ready"));
    const held = publisher.hold("stuck");

    const swept = await relaying({ tenants: ["acme", "globex"] }, () =>
      fromSafePromise(
        (async () => {
          try {
            await held.entered;
            await vi.waitUntil(() => publisher.sent().includes("ready"));
            return [...publisher.sent()];
          } finally {
            held.release();
          }
        })(),
      ),
    );

    expect(swept).toBeOkWith(["ready"]);
    expect(publisher.sent()).toEqual(["ready", "stuck"]);
  });

  it("keeps one tenant's back-off from slowing another tenant's backlog", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a fact one tenant's transport refuses forever, and another
    // tenant's backlog of several full batches
    store.append(order("acme", "poison"));
    publisher.refuse("poison");
    const ids = Array.from({ length: 100 }, (_, index) => `g-${String(index)}`);
    for (const id of ids) store.append(order("globex", id));

    // WHEN the relay starts, and no time passes
    const swept = await relaying({ tenants: ["acme", "globex"] }, () =>
      clock.advance(0).map(() => publisher.sent()),
    );

    // THEN the second tenant's whole backlog went out: the first tenant's
    // back-off is its own
    expect(swept).toBeOkWith(ids);
  });

  it("never hands two relays over one store the same message", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a backlog, and a transport slow enough that two relays overlap
    const ids = Array.from({ length: 40 }, (_, index) => `m-${String(index)}`);
    for (const id of ids) store.append(order("acme", id));
    publisher.slow();

    // WHEN a second relay starts while the first is mid-batch
    const swept = await relaying({ tenants: ["acme"] }, () =>
      relaying({ tenants: ["acme"] }, () =>
        fromSafePromise(
          vi.waitUntil(async () => (await store.pending("acme", 1)).get().length === 0),
        ).flatMap(() => clock.advance(0)),
      ).map(() => publisher.sent()),
    );

    // THEN each went out once, in order
    expect(swept).toBeOkWith(ids);
  });

  it("stops polling when the scope closes", async ({ store, publisher, clock, relaying }) => {
    // GIVEN a relay that ran and was released
    const ran = await relaying({ tenants: ["acme"] }, () => clock.advance(0));

    // WHEN a fact is committed afterwards and time passes
    store.append(order("acme", "late"));
    await clock.advance(60_000);

    // THEN nothing published it
    expect({ ran, sent: publisher.sent() }).toEqual({ ran: expect.anything(), sent: [] });
  });

  it("reports a store that cannot answer, and retries it", async ({
    store,
    publisher,
    clock,
    observations,
    relaying,
  }) => {
    // GIVEN a fact, and a store whose first claim dies
    store.append(order("acme", "a"));
    let down = true;
    const flaky = {
      ...store,
      claim: (...args: Parameters<typeof store.claim>) => {
        if (!down) return store.claim(...args);
        down = false;
        return fromSafePromise(Promise.reject(new Error("the database is down")));
      },
    };

    // WHEN the relay sweeps, backs off, and sweeps again
    const swept = await relaying(
      { tenants: ["acme"], pollMs: 100 },
      () =>
        clock.advance(200).map(() => ({
          claims: observations.filter((o) => o.name === "claim").map((o) => o.outcome),
          sent: publisher.sent(),
        })),
      flaky,
    );

    // THEN the failure was observed and the fact still went out
    expect(swept).toBeOkWith({ claims: ["error", "ok"], sent: ["a"] });
  });

  it("reports each claim and publish to Observers, the subject as a detail", async ({
    store,
    clock,
    observations,
    relaying,
  }) => {
    // GIVEN one fact
    store.append(order("acme", "a"));

    // WHEN the relay sweeps once
    const swept = await relaying({ tenants: ["acme"] }, () =>
      clock.advance(0).map(() => observations),
    );

    // THEN the publish carries bounded dimensions and an unbounded detail, and
    // the claim around it opens no span
    expect(swept).toBeOkWith([
      {
        component: "outbox",
        name: "publish",
        attributes: { operation: "publish", kind: "order", "btravstack.tenant_id": "acme" },
        details: { "btravstack.outbox.id": 1, "btravstack.outbox.subject": "a" },
        outcome: "ok",
        traced: true,
      },
      {
        component: "outbox",
        name: "claim",
        attributes: { operation: "claim", "btravstack.tenant_id": "acme" },
        details: {},
        outcome: "ok",
        traced: false,
      },
    ]);
  });

  it("reads its tenants from OUTBOX_TENANTS", async ({ store, publisher, clock, relaying }) => {
    // GIVEN facts for two tenants, named only by the environment
    store.append(order("acme", "a"));
    store.append(order("globex", "g"));

    // WHEN the relay is composed with nothing pinned
    const swept = await relaying({ env: { OUTBOX_TENANTS: "acme, globex" } }, () =>
      clock.advance(0).map(() => publisher.sent()),
    );

    // THEN both are swept
    expect(swept).toBeOkWith(["a", "g"]);
  });

  it("refuses to start without tenants", async ({ relaying, clock }) => {
    // GIVEN an environment naming none
    // WHEN the relay is composed
    const started = await relaying({ env: {} }, () => clock.advance(0));

    // THEN the graph fails to build, naming the variable
    expect(started).toBeErrWith(
      expect.objectContaining({
        _tag: "ConfigInvalid",
        message: expect.stringContaining("OUTBOX_TENANTS"),
      }),
    );
  });

  it("is healthy while nothing pending is older than maxLagMs", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a stuck fact that is still young
    store.append(order("acme", "stuck"));
    publisher.refuse("stuck");

    // WHEN /healthz asks, before the lag allowance has passed
    const report = await relaying({ tenants: ["acme"], maxLagMs: 5_000 }, (ctx) =>
      clock.advance(5_000).flatMap(() => runHealthChecks(ctx.get(HealthChecks))),
    );

    // THEN the outbox is healthy
    expect(report).toBeOkWith({
      status: "healthy",
      components: [{ name: "outbox", status: "healthy" }],
    });
  });

  it("asks the store about every tenant in one call", async ({ store, clock, relaying }) => {
    // GIVEN a store that counts what /healthz costs it
    let calls = 0;
    const counted = {
      ...store,
      pending: (...args: Parameters<typeof store.pending>) => {
        calls += 1;
        return store.pending(...args);
      },
      oldestPending: (...args: Parameters<typeof store.oldestPending>) => {
        calls += 1;
        return store.oldestPending(...args);
      },
    };

    // WHEN /healthz asks, for three tenants
    const asked = await relaying(
      { tenants: ["acme", "globex", "initech"] },
      (ctx) =>
        clock
          .advance(0)
          .map(() => (calls = 0))
          .flatMap(() => runHealthChecks(ctx.get(HealthChecks)))
          .map(() => calls),
      counted,
    );

    // THEN one round trip answered for all three, however many tenants there are
    expect(asked).toBeOkWith(1);
  });

  it("reports the tenant whose oldest pending message is older than maxLagMs", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN a fact the transport refuses forever
    store.append(order("acme", "stuck"));
    publisher.refuse("stuck");

    // WHEN /healthz asks once it has waited longer than allowed
    const report = await relaying({ tenants: ["acme", "globex"], maxLagMs: 5_000 }, (ctx) =>
      clock.advance(6_000).flatMap(() => runHealthChecks(ctx.get(HealthChecks))),
    );

    // THEN the outbox is unhealthy, naming the tenant that is behind
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [{ name: "outbox", status: "unhealthy", reason: "acme is 6000 ms behind" }],
    });
  });
});
