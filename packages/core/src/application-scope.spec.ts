import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("application-scoped infrastructure", () => {
  it("parses configuration once, at boot, however many units read it", async ({
    applicationScope,
  }) => {
    // GIVEN an application whose unit module injects the root's configuration
    const { runtime, units, seen } = applicationScope.boot({ APP_MAX_ITEMS: "5" });
    await runtime.untilStarted();

    // WHEN three units run
    await units(3);

    // THEN every unit read the one value parsed before readiness
    expect({ parses: seen.parses, read: seen.units.map(({ maxItems }) => maxItems) }).toEqual({
      parses: 1,
      read: [5, 5, 5],
    });
  });

  it("keeps two simultaneous applications' configuration and clients apart", async ({
    applicationScope,
  }) => {
    // GIVEN two applications from the same modules, booted side by side
    const first = applicationScope.boot({ APP_MAX_ITEMS: "5" }, { name: "first" });
    const second = applicationScope.boot({ APP_MAX_ITEMS: "7" }, { name: "second" });
    await first.runtime.untilStarted();
    await second.runtime.untilStarted();

    // WHEN each runs a unit
    await first.units(1);
    await second.units(1);

    // THEN each unit read its own application's value and client
    expect({ first: first.seen.units, second: second.seen.units }).toEqual({
      first: [{ maxItems: 5, client: "first" }],
      second: [{ maxItems: 7, client: "second" }],
    });
  });

  it("fails the boot on configuration only a unit reads, before any unit runs", async ({
    applicationScope,
  }) => {
    // GIVEN an invalid value for a variable no root provider reads
    const { app, runtime } = applicationScope.boot({ APP_MAX_ITEMS: "many" });

    // WHEN the application settles
    const exited = await app.exited;

    // THEN it never served: the configuration was validated as the graph was built
    expect({ exited, started: runtime.started() }).toEqual({
      exited: expect.objectContaining({
        error: expect.objectContaining({ _tag: "ConfigInvalid", port: "ScopeFixturePolicy" }),
      }),
      started: false,
    });
  });

  it("releases application services once at shutdown and unit services once per unit", async ({
    applicationScope,
  }) => {
    // GIVEN three units served by one application
    const { app, runtime, units, seen } = applicationScope.boot({ APP_MAX_ITEMS: "5" });
    await runtime.untilStarted();
    await units(3);

    // WHEN the application stops
    app.stop();
    await app.exited;

    // THEN each scope released what it owns, exactly once
    expect({ appStops: seen.appStops, unitStops: seen.unitStops }).toEqual({
      appStops: 1,
      unitStops: 3,
    });
  });

  it("refuses a unit module that rebuilds a port the application provides", async ({
    applicationScope,
  }) => {
    // GIVEN a unit module that also provides the root's client
    const { app } = applicationScope.boot({ APP_MAX_ITEMS: "5" }, { rebuilding: true });

    // WHEN the application settles
    // THEN the boot is a defect naming the kind, the runtime and the port
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message: expect.stringContaining(
          '[core] unit kind "test" of runtime "test" provides port "ScopeFixtureClient", which the application scope already provides',
        ),
      }),
    );
  });
});
