import { overridden, testRuntime } from "@btravstack/testing";
import { Ok } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("unit overrides", () => {
  it("merges every contribution for one kind into the module the fork builds", async ({
    unitOverride: { built, kind, stub, rootOf, start },
  }) => {
    // GIVEN two nested overrides, each substituting a different port inside one kind
    const runtime = testRuntime("test", { unit: kind });
    start(
      overridden(
        overridden(rootOf(runtime), [], { unit: { test: [stub("greeter", "stub greeter")] } }),
        [],
        {
          unit: { test: [stub("farewell", "stub farewell")] },
        },
      ),
    );
    await runtime.untilStarted();

    // WHEN one unit is forked and settled
    const unit = runtime.submit();
    unit.settle(Ok("done"));

    // THEN both overrides were built, and neither base
    await expect(unit.result.map(() => built().toSorted())).toBeOkWith([
      "stub farewell",
      "stub greeter",
    ]);
  });

  it("refuses a kind the runtime binds no module for", async ({
    unitOverride: { stub, rootOf, start },
  }) => {
    // GIVEN a runtime binding no unit module
    const runtime = testRuntime();

    // WHEN it is started with an override for a kind
    const app = start(
      overridden(rootOf(runtime), [], { unit: { user: [stub("greeter", "stub")] } }),
    );

    // THEN the boot is a defect naming the kind and the runtime
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message: '[core] unit override for kind "user", which runtime "test" binds no module for',
      }),
    );
  });

  it("refuses a port the kind's module does not provide", async ({
    unitOverride: { empty, stub, rootOf, start },
  }) => {
    // GIVEN a kind module providing neither port
    const runtime = testRuntime("test", { unit: empty });

    // WHEN it is started with an override for one of them
    const app = start(
      overridden(rootOf(runtime), [], { unit: { test: [stub("greeter", "stub")] } }),
    );

    // THEN the boot is the drift defect, naming the port and the kind
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message:
          '[core] unit override for port "UnitOverrideGreeter" in kind "test" with nothing to override — its module no longer provides it',
      }),
    );
  });

  it("refuses two overrides for one port in one kind at boot, not at the first fork", async ({
    unitOverride: { kind, stub, rootOf, start },
  }) => {
    // GIVEN two nested overrides substituting the same port inside one kind
    const runtime = testRuntime("test", { unit: kind });

    // WHEN the root is started
    const app = start(
      overridden(
        overridden(rootOf(runtime), [], { unit: { test: [stub("greeter", "first")] } }),
        [],
        {
          unit: { test: [stub("greeter", "second")] },
        },
      ),
    );

    // THEN the boot is a defect naming the port and the kind
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message:
          '[core] two unit overrides registered for port "UnitOverrideGreeter" in kind "test"',
      }),
    );
  });

  it("refuses a module bound under two kinds, since a fork cannot tell them apart", async ({
    unitOverride: { kind, stub, rootOf, start },
  }) => {
    // GIVEN a runtime binding one module under two kinds
    const runtime = { ...testRuntime(), units: { user: kind, session: kind } };

    // WHEN one of the two kinds is overridden
    const app = start(
      overridden(rootOf(runtime), [], { unit: { user: [stub("greeter", "stub")] } }),
    );

    // THEN the boot is a defect naming both kinds
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message:
          '[core] unit override for kind "user", whose module kind "session" binds too — an override cannot reach one without the other',
      }),
    );
  });
});
