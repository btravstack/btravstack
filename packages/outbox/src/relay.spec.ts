import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { Temporal } from "temporal-polyfill";
import { type AsyncResult, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

const order = (tenantId: string, subjectId: string) => ({
  tenantId,
  kind: "order",
  subjectId,
  payload: "{}",
});

describe("outbox", () => {
  it("preserves occurrence microseconds at the publisher boundary", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN
    const occurredAt = Temporal.Instant.from("2026-10-26T12:00:00.123456Z");
    store.append({ ...order("acme", "a"), occurredAt });

    // WHEN
    const timestamps = await relaying({ tenants: ["acme"] }, () =>
      clock
        .advance(0)
        .map(() => publisher.messages().map((message) => message.occurredAt.epochNanoseconds)),
    );

    // THEN
    expect(timestamps).toBeOkWith([occurredAt.epochNanoseconds]);
  });

  it("measures submillisecond lag at the health threshold", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN
    const occurredAt = Temporal.Instant.fromEpochMilliseconds(clock.now()).subtract({
      microseconds: 1,
    });
    store.append({ ...order("acme", "stuck"), occurredAt });
    publisher.refuse("stuck");

    // WHEN
    const report = await relaying({ tenants: ["acme"], maxLagMs: 5_000 }, (ctx) =>
      clock.advance(5_000).flatMap(() => runHealthChecks(ctx.get(HealthChecks))),
    );

    // THEN
    expect(report).toBeOkWith({
      status: "unhealthy",
      components: [{ name: "outbox", status: "unhealthy", reason: "acme is 5000.001 ms behind" }],
    });
  });

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
    // GIVEN two tenants, with the first publish held open
    store.append(order("acme", "stuck"));
    store.append(order("globex", "ready"));
    const held = publisher.hold("stuck");

    // WHEN the other tenant's fact appears before releasing the first
    const swept = await relaying({ tenants: ["acme", "globex"] }, () =>
      fromSafePromise(
        (async () => {
          await held.entered;
          await vi.waitUntil(() => publisher.sent().includes("ready"));
          return [...publisher.sent()];
        })(),
      )
        .tap(() => held.release())
        .tapFailure(() => held.release()),
    );

    // THEN the second tenant made progress while the first waited, and both finish
    expect({ beforeRelease: swept.getOrThrow(), afterRelease: publisher.sent() }).toEqual({
      beforeRelease: ["ready"],
      afterRelease: ["ready", "stuck"],
    });
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

  it("holds at most OUTBOX_CONCURRENCY claims at once, and serves every tenant", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN five tenants with a fact each, and a store that counts open claims
    const tenants = ["a", "b", "c", "d", "e"];
    for (const tenant of tenants) store.append(order(tenant, tenant));
    let open = 0;
    let peak = 0;
    const counted = {
      ...store,
      claim: (...args: Parameters<typeof store.claim>) => {
        open += 1;
        peak = Math.max(peak, open);
        return store.claim(...args).tap(() => {
          open -= 1;
        });
      },
    };

    // WHEN the relay sweeps with two slots
    const swept = await relaying(
      { tenants, env: { OUTBOX_CONCURRENCY: "2" } },
      () => clock.advance(0).map(() => ({ peak, sent: publisher.sent() })),
      counted,
    );

    // THEN never more than two claims were open, and every tenant went out in turn
    expect(swept).toBeOkWith({ peak: 2, sent: tenants });
  });

  it("counts a prune against OUTBOX_CONCURRENCY like a claim", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN two tenants with a fact each, retention on, and a store that counts
    // open claims and prunes together
    store.append(order("acme", "a"));
    store.append(order("globex", "g"));
    let open = 0;
    let peak = 0;
    const opened = <T>(call: () => AsyncResult<T, never>) => {
      open += 1;
      peak = Math.max(peak, open);
      return call().tap(() => {
        open -= 1;
      });
    };
    const counted = {
      ...store,
      claim: (...args: Parameters<typeof store.claim>) => opened(() => store.claim(...args)),
      prune: (...args: Parameters<typeof store.prune>) => opened(() => store.prune(...args)),
    };

    // WHEN the relay sweeps and prunes both with one slot
    const swept = await relaying(
      { tenants: ["acme", "globex"], concurrency: 1, retainMs: 1 },
      () => clock.advance(0).map(() => ({ peak, sent: publisher.sent() })),
      counted,
    );

    // THEN no prune ran beside another tenant's claim
    expect(swept).toBeOkWith({ peak: 1, sent: ["a", "g"] });
  });

  it("hands a freed slot to the waiting tenant before a backlog takes it back", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN two tenants each with more than one batch, and one slot
    const backlog = (tenant: string) =>
      Array.from({ length: 40 }, (_, index) => `${tenant}-${String(index)}`);
    for (const tenant of ["acme", "globex"])
      for (const id of backlog(tenant)) store.append(order(tenant, id));

    // WHEN the relay drains both, and no time passes
    const swept = await relaying({ tenants: ["acme", "globex"], concurrency: 1 }, () =>
      clock.advance(0).map(() => publisher.sent()),
    );

    // THEN the tenants alternated batch by batch
    expect(swept).toBeOkWith([
      ...backlog("acme").slice(0, 32),
      ...backlog("globex").slice(0, 32),
      ...backlog("acme").slice(32),
      ...backlog("globex").slice(32),
    ]);
  });

  it("stops a tenant waiting for a slot without sweeping it", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN one slot, held by a publish the test controls, and a second tenant queued behind it
    store.append(order("acme", "held"));
    store.append(order("globex", "queued"));
    const held = publisher.hold("held");

    // WHEN the scope closes while the slot is held, and the publish then settles
    const closing = relaying({ tenants: ["acme", "globex"], concurrency: 1 }, () =>
      fromSafePromise(held.entered),
    );
    await clock.advance(0);
    held.release();
    const closed = await closing.map(() => publisher.sent());

    // THEN release waited for the batch in flight, and the queued tenant never swept
    expect(closed).toBeOkWith(["held"]);
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

  it("deletes a published message once it is older than retainMs", async ({
    store,
    clock,
    relaying,
  }) => {
    // GIVEN a fact, and a relay keeping published rows for a second
    store.append(order("acme", "a"));

    // WHEN it is published, and a prune round falls due a minute later
    const left = await relaying({ tenants: ["acme"], retainMs: 1_000 }, () =>
      clock
        .advance(0)
        .flatMap(() => clock.advance(60_000))
        .flatMap(() => store.prune("acme", 0, 10)),
    );

    // THEN the relay had already deleted it: nothing published is left to prune
    expect(left).toBeOkWith(0);
  });

  it("prunes a batch per idle sweep, so publishing interleaves with a long history", async ({
    store,
    clock,
    observations,
    relaying,
  }) => {
    // GIVEN more published history than one prune batch deletes
    for (let i = 0; i < 1_001; i++) store.append(order("acme", `m${String(i)}`));

    // WHEN it is all published, and pruning falls due a minute later
    const ran = await relaying({ tenants: ["acme"], retainMs: 1_000 }, () =>
      clock
        .advance(0)
        .flatMap(() => clock.advance(61_000))
        .flatMap(() => clock.advance(1_000))
        .flatMap(() => store.prune("acme", 0, 10_000))
        .map((left) => ({
          left,
          adjacentPrunes: observations
            .filter(({ name }) => name === "prune" || name === "claim")
            .map(({ name }) => name)
            .join(",")
            .includes("prune,prune"),
        })),
    );

    // THEN every row went, and a sweep ran between the two batches
    expect(ran).toBeOkWith({ left: 0, adjacentPrunes: false });
  });

  it("wakes for the next backlog batch sooner than a long poll interval", async ({
    store,
    clock,
    relaying,
  }) => {
    // GIVEN more published history than one batch, and a five-second poll
    for (let i = 0; i < 1_001; i++) store.append(order("acme", `m${String(i)}`));

    // WHEN pruning falls due, and two seconds pass after it — under one poll
    const left = await relaying({ tenants: ["acme"], retainMs: 1_000, pollMs: 5_000 }, () =>
      clock
        .advance(0)
        .flatMap(() => clock.advance(60_000))
        .flatMap(() => clock.advance(2_000))
        .flatMap(() => store.prune("acme", 0, 10_000)),
    );

    // THEN the second batch ran a second after the first, not at the next poll
    expect(left).toBeOkWith(0);
  });

  it("prunes a tenant whose next message the publisher refuses forever", async ({
    store,
    publisher,
    clock,
    relaying,
  }) => {
    // GIVEN one published fact, then one the transport refuses forever
    store.append(order("acme", "a"));

    // WHEN the refusal holds the tenant's sweeps failed past the retention
    const left = await relaying({ tenants: ["acme"], retainMs: 1_000 }, () =>
      clock
        .advance(0)
        .flatMap(() => {
          store.append(order("acme", "b"));
          publisher.refuse("b");
          return clock.advance(61_000);
        })
        .flatMap(() => clock.advance(1_000))
        .flatMap(() => store.prune("acme", 0, 10)),
    );

    // THEN the published row was pruned anyway: retention does not wait for
    // the publisher
    expect(left).toBeOkWith(0);
  });

  it("drains a prune backlog without retrying a refused publish early", async ({
    store,
    publisher,
    clock,
    observations,
    relaying,
  }) => {
    // GIVEN five batches of published history, then a fact the transport
    // refuses forever, its backoff grown long
    for (let i = 0; i < 5_001; i++) store.append(order("acme", `m${String(i)}`));
    const refusals = () =>
      observations.filter(({ name, outcome }) => name === "publish" && outcome === "error").length;
    const seconds = (n: number) =>
      Array.from({ length: n }).reduce<AsyncResult<void, never>>(
        (stepped) => stepped.flatMap(() => clock.advance(1_000)),
        OkAsync(),
      );

    // WHEN the history is pruned, a batch a second
    const retried = await relaying({ tenants: ["acme"], retainMs: 1_000 }, () =>
      clock
        .advance(0)
        .flatMap(() => {
          store.append(order("acme", "x"));
          publisher.refuse("x");
          return seconds(59);
        })
        .map(refusals)
        .flatMap((before) =>
          seconds(6)
            .flatMap(() => store.prune("acme", 0, 10_000))
            .map((left) => ({ left, retries: refusals() - before })),
        ),
    );

    // THEN it all went, and the refused fact waited out its backoff
    expect(retried).toBeOkWith({ left: 0, retries: 0 });
  });

  it("keeps published messages when no retention is set", async ({ store, clock, relaying }) => {
    // GIVEN a fact, and a relay with no retention
    store.append(order("acme", "a"));

    // WHEN it is published, and a minute passes
    const left = await relaying({ tenants: ["acme"] }, () =>
      clock
        .advance(0)
        .flatMap(() => clock.advance(60_000))
        .flatMap(() => store.prune("acme", 0, 10)),
    );

    // THEN the published row is still there
    expect(left).toBeOkWith(1);
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
