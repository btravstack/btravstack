import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("readiness health checks", () => {
  it("recovers without a restart and evaluates at most once per configured interval", async ({
    boot,
    readiness: kit,
  }) => {
    // GIVEN a required dependency that is initially unavailable
    const app = boot(kit.root({ intervalMs: 250 }), {
      clock: kit.clock,
      probes: { port: 0, host: "127.0.0.1" },
    });
    await app.runtimeInfo();
    // WHEN the dependency recovers inside the interval, then the interval expires
    const failed = await kit.status(app, "/readyz");
    kit.available(true);
    await kit.clock.advance(249);
    const cached = await kit.status(app, "/readyz");
    await kit.clock.advance(1);
    const recovered = await kit.status(app, "/readyz");
    // THEN failure and recovery affect readiness, while liveness and the lifecycle stay serving
    expect({
      statuses: [failed, cached, recovered],
      live: await kit.status(app, "/livez"),
      phase: app.phase(),
      ready: app.ready(),
      calls: kit.calls(),
    }).toEqual({ statuses: [503, 503, 200], live: 200, phase: "serving", ready: true, calls: 2 });
  });

  it("does not let ordinary health checks gate readiness", async ({ boot, readiness: kit }) => {
    // GIVEN a failing check without readiness opt-in
    const app = boot(kit.root(false), {
      probes: { port: 0, host: "127.0.0.1" },
    });
    await app.runtimeInfo();
    // WHEN both endpoints are probed
    const ready = await kit.status(app, "/readyz");
    const health = await kit.status(app, "/healthz");
    // THEN only the full health report fails
    expect({ ready, health, calls: kit.calls() }).toEqual({ ready: 200, health: 503, calls: 1 });
  });

  it("shares one pending evaluation across ready and health probes", async ({
    boot,
    readiness: kit,
  }) => {
    // GIVEN a check whose answer is held until every probe has started
    const held = kit.hold();
    kit.available(true);
    const app = boot(kit.root(), { clock: kit.clock, probes: { port: 0, host: "127.0.0.1" } });
    await app.runtimeInfo();
    // WHEN concurrent probes wait on it
    const ready = kit.status(app, "/readyz");
    await held.entered;
    const health = kit.status(app, "/healthz");
    const another = kit.status(app, "/readyz");
    await kit.clock.advance(0);
    held.release();
    const statuses = await Promise.all([ready, health, another]);
    // THEN the optional failing component remains visible and the dependency runs once
    expect({ statuses, calls: kit.calls() }).toEqual({ statuses: [200, 503, 200], calls: 1 });
  });

  it("cannot restore readiness when a drain begins during a check", async ({
    boot,
    readiness: kit,
  }) => {
    // GIVEN an in-flight readiness probe
    const held = kit.hold();
    kit.available(true);
    const app = boot(kit.root(), {
      clock: kit.clock,
      preDrainDelayMs: 1000,
      probes: { port: 0, host: "127.0.0.1" },
    });
    await app.runtimeInfo();
    const response = kit.status(app, "/readyz");
    await held.entered;
    // WHEN draining starts before the healthy answer returns
    app.requestDrain();
    await kit.clock.advance(0);
    held.release();
    const status = await response;
    const draining = await kit.status(app, "/readyz");
    await kit.clock.advance(1000);
    // THEN neither the in-flight answer nor a later probe revives readiness
    expect({ status, draining, ready: app.ready(), calls: kit.calls() }).toEqual({
      status: 503,
      draining: 503,
      ready: false,
      calls: 1,
    });
  });

  it("shares pending work across intervals and starts the cache lifetime on settlement", async ({
    readiness: kit,
  }) => {
    // GIVEN a dependency whose first evaluation outlasts the cache interval
    kit.available(true);
    const held = kit.hold();
    const monitor = kit.monitor();
    const first = monitor.readiness();
    await held.entered;
    await kit.clock.advance(2000);
    // WHEN further health and readiness requests arrive before it settles
    const health = monitor.health();
    const second = monitor.readiness();
    await kit.clock.advance(0);
    const pendingCalls = kit.calls();
    held.release();
    await Promise.all([first, health, second]);
    kit.available(false);
    await kit.clock.advance(999);
    const cached = (await monitor.readiness()).get();
    await kit.clock.advance(1);
    const refreshed = (await monitor.readiness()).get();
    // THEN there is one in-flight evaluation and a full interval of cached health after settlement
    expect({ pendingCalls, cached, refreshed, calls: kit.calls() }).toEqual({
      pendingCalls: 1,
      cached: true,
      refreshed: false,
      calls: 2,
    });
  });

  it("uses a one-second default cache and refreshes every ordinary component", async ({
    readiness: kit,
  }) => {
    // GIVEN a healthy required component and an unhealthy optional one
    kit.available(true);
    const monitor = kit.monitor();
    // WHEN health and readiness are polled before and at the default expiry
    await monitor.health();
    kit.available(false);
    await kit.clock.advance(999);
    const cached = (await monitor.readiness()).get();
    await kit.clock.advance(1);
    const expired = (await monitor.readiness()).get();
    const report = (await monitor.health()).get();
    // THEN the cached dependency refreshes, and health still names both components
    expect({
      cached,
      expired,
      report,
      calls: kit.calls(),
      optionalCalls: kit.optionalCalls(),
    }).toEqual({
      cached: true,
      expired: false,
      optionalCalls: 2,
      calls: 2,
      report: {
        status: "unhealthy",
        components: [
          { name: "credentials", status: "unhealthy", reason: "credentials unavailable" },
          { name: "optional", status: "unhealthy", reason: "offline" },
        ],
      },
    });
  });

  it.for([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed for an invalid readiness interval (%s)",
    async (intervalMs, { readiness: kit }) => {
      // GIVEN an invalid interval that cannot provide a bounded evaluation rate
      const monitor = kit.monitor({ intervalMs });
      // WHEN both reports are requested
      const ready = (await monitor.readiness()).get();
      const report = (await monitor.health()).get();
      // THEN it is unhealthy without invoking the dependency
      expect({ ready, component: report.components[0], calls: kit.calls() }).toEqual({
        ready: false,
        component: {
          name: "credentials",
          status: "unhealthy",
          reason: "readiness interval must be a positive finite number",
        },
        calls: 0,
      });
    },
  );
});
