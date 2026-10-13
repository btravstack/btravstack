import { runHealthChecks, HealthChecks } from "@btravstack/core";
import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("standalone outbox runtime", () => {
  it("does not poll until startup and serves the existing health check", async ({
    standalone,
    publisher,
    store,
    clock,
  }) => {
    // GIVEN a committed fact
    store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
    // WHEN the runtime starts
    const result = await standalone((runtime, ctx, host) => {
      const before = publisher.sent().slice();
      return runtime.start(host).flatMap((serving) =>
        clock
          .advance(0)
          .flatTap(() => runHealthChecks(ctx.get(HealthChecks)))
          .flatTap(() => serving.stop())
          .map(() => ({ before, sent: publisher.sent() })),
      );
    });
    // THEN polling starts only at startup
    expect(result).toBeOkWith({ before: [], sent: ["a"] });
  });

  it("stops new claims while finishing the current delivery", async ({
    standalone,
    publisher,
    store,
    clock,
  }) => {
    // GIVEN a held delivery
    store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
    const held = publisher.hold("a");
    // WHEN drain starts during the claim
    const result = await standalone((runtime, _ctx, host) =>
      runtime.start(host).flatMap((serving) =>
        fromSafePromise(
          (async () => {
            await held.entered;
            const stopped = serving.stopped!();
            let unexpected = false;
            void stopped.then(() => {
              unexpected = true;
            });
            const draining = serving.drain(new AbortController().signal);
            store.append({ tenantId: "acme", kind: "order", subjectId: "b", payload: "{}" });
            held.release();
            await draining;
            await clock.advance(1000);
            await serving.stop();
            return { sent: publisher.sent(), unexpected };
          })(),
        ),
      ),
    );
    // THEN only the current batch completed and requested shutdown withdrew its notification
    expect(result).toBeOkWith({ sent: ["a"], unexpected: false });
  });

  it("honours an already expired drain deadline", async ({ standalone, publisher, store }) => {
    // GIVEN a held delivery and expired deadline
    store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
    const held = publisher.hold("a");
    const deadline = new AbortController();
    deadline.abort();
    // WHEN drain is called
    const result = await standalone((runtime, _ctx, host) =>
      runtime.start(host).flatMap((serving) =>
        fromSafePromise(
          (async () => {
            await held.entered;
            await serving.drain(deadline.signal);
            const sent = publisher.sent().slice();
            held.release();
            await serving.stop();
            return sent;
          })(),
        ),
      ),
    );
    // THEN drain returned before delivery finished
    expect(result).toBeOkWith([]);
  });

  it("can close a graph that never started", async ({ standalone }) => {
    // GIVEN a constructed graph
    // WHEN its scope closes before startup
    const result = await standalone(() => OkAsync());
    // THEN no runtime resource needs releasing
    expect(result).toBeOk();
  });
  it("reports an unexpected loop failure", async ({ standalone, clock }) => {
    // GIVEN a clock that fails inside the poll loop
    const failure = new Error("clock failed");
    const broken = {
      ...clock,
      now: () => {
        // oxlint-disable-next-line unthrown/no-throw -- a failed poll loop is the subject under test
        throw failure;
      },
    };
    // WHEN the runtime starts and the loop fails
    const result = await standalone(
      (runtime, _ctx, host) => runtime.start(host).flatMap((serving) => serving.stopped!()),
      { clock: broken },
    );
    // THEN the runtime reports the defect rather than remaining ready forever
    expect(result).toBeDefect();
  });

  it("boots with kernel probes and closes dependency resources", async ({ launch, releases }) => {
    // GIVEN a standalone root with resourceful dependencies
    const app = launch({ probes: { host: "127.0.0.1", port: 0 } });
    // WHEN the kernel serves probes and stops
    const port = (await app.probePort()).get()!;
    const live = await fetch(`http://127.0.0.1:${port}/livez`);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    app.stop();
    const report = await app.exited;
    // THEN probes and scope teardown use the kernel lifecycle
    expect({
      live: live.status,
      ready: ready.status,
      health: health.status,
      report: report.isOk(),
      releases,
    }).toEqual({
      live: 200,
      ready: 200,
      health: 200,
      report: true,
      releases: ["publisher", "store"],
    });
  });

  it("accounts for unfinished claims at the drain deadline and retains resources", async ({
    launch,
    publisher,
    store,
    clock,
    releases,
  }) => {
    // GIVEN an in-flight claim
    store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
    const held = publisher.hold("a");
    const app = launch({ drainTimeoutMs: 100, stopTimeoutMs: 100 });
    await held.entered;
    // WHEN the kernel drains past both deadlines
    app.requestDrain();
    await clock.advance(0);
    await vi.waitUntil(() => app.phase() === "draining");
    await clock.advance(100);
    await vi.waitUntil(() => app.phase() === "stopping");
    await clock.advance(100);
    const report = (await app.exited).getOrThrow();
    const before = releases.slice();
    held.release();
    await vi.waitUntil(() => releases.length === 2);
    // THEN the abandoned claim was counted and dependencies stayed open until it finished
    expect({ drain: report.drain, abandonedAt: report.abandonedAt, before, releases }).toEqual({
      drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 },
      abandonedAt: "stop",
      before: [],
      releases: ["publisher", "store"],
    });
  });
  it("refuses invalid configuration before polling", async ({ standalone }) => {
    // GIVEN an invalid polling interval
    // WHEN the graph is constructed
    const result = await standalone(() => OkAsync(), { pollMs: 0 });
    // THEN startup fails with the configuration error
    expect(result).toBeErrTagged("ConfigInvalid");
  });

  it("does not publish pending messages when configuration is invalid", async ({
    standalone,
    publisher,
    store,
  }) => {
    // GIVEN a pending message and an invalid polling interval
    store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
    // WHEN the graph is constructed
    await standalone(() => OkAsync(), { pollMs: 0 }).getOrNull();
    // THEN no message was published
    expect(publisher.sent()).toEqual([]);
  });

  it("drains a current claim cleanly before releasing dependencies", async ({
    launch,
    publisher,
    store,
    clock,
    releases,
  }) => {
    // GIVEN an in-flight delivery
    store.append({ tenantId: "acme", kind: "order", subjectId: "a", payload: "{}" });
    const held = publisher.hold("a");
    const app = launch();
    await held.entered;
    // WHEN the application drains and the delivery finishes within its budget
    app.requestDrain();
    await clock.advance(0);
    await vi.waitUntil(() => app.phase() === "draining");
    const during = releases.slice();
    held.release();
    const report = (await app.exited).getOrThrow();
    // THEN accounting and resource release both reflect the completed claim
    expect({ drain: report.drain, during, releases }).toEqual({
      drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      during: [],
      releases: ["publisher", "store"],
    });
  });
  it(
    "keeps a standalone process alive through shutdown deadlines and teardown",
    { timeout: 15_000 },
    async ({ shutdownProcess }) => {
      // GIVEN a subprocess whose publisher waits on an unresolved promise
      await shutdownProcess.untilStarted.get();
      // WHEN SIGTERM requests drain
      shutdownProcess.drain();
      await shutdownProcess.untilReleased.get();
      // THEN the process reported the abandoned claim and stop deadline before releasing its store
      expect(shutdownProcess.output()).toEqual(
        expect.stringMatching(
          /"abandoned":1[\s\S]*"type":"stoppedWaiting"[\s\S]*shutdown reported[\s\S]*store released/,
        ),
      );
    },
  );
});
