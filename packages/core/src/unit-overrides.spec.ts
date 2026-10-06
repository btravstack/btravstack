import { Module, Port, Provider } from "@btravstack/di";
import { TestRuntimePort, overridden, testRuntime, type TestRuntime } from "@btravstack/testing";
import { Ok } from "unthrown";
import { describe, expect, test } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { start } from "./start.js";

class Greeter extends Port("UnitOverrideGreeter")<{ readonly text: string }> {}
class Farewell extends Port("UnitOverrideFarewell")<{ readonly text: string }> {}

/** What the kind module's two providers answer, recorded as they are built. */
const kindOf = (built: string[]) =>
  Module("Kind")({
    provides: [
      Provider(Greeter)({
        inject: {},
        sync: () => {
          built.push("real greeter");
          return { text: "real" };
        },
      }),
      Provider(Farewell)({
        inject: {},
        sync: () => {
          built.push("real farewell");
          return { text: "real" };
        },
      }),
    ],
    exports: [Greeter, Farewell],
  });

const stubbing = (built: string[], port: typeof Greeter | typeof Farewell, name: string) =>
  Provider(port)({
    inject: {},
    sync: () => {
      built.push(name);
      return { text: "stub" };
    },
  });

const rootOver = <U extends Module<never, never, unknown> | undefined>(runtime: TestRuntime<U>) =>
  Module("UnitRoot")({ imports: [runtime.module], exports: [TestRuntimePort] });

const quiet = { signals: false, probes: false, onEvent: () => {} } as const;

describe("unit overrides", () => {
  it("merges every contribution for one kind into the module the fork builds", async ({ boot }) => {
    // GIVEN two nested overrides, each substituting a different port inside one kind
    const built: string[] = [];
    const runtime = testRuntime("test", { unit: kindOf(built) });
    boot(
      overridden(
        overridden(rootOver(runtime), [], {
          unit: { test: [stubbing(built, Greeter, "stub greeter")] },
        }),
        [],
        { unit: { test: [stubbing(built, Farewell, "stub farewell")] } },
      ),
    );
    await runtime.untilStarted();

    // WHEN one unit is forked and settled
    const unit = runtime.submit();
    unit.settle(Ok("done"));

    // THEN both overrides were built, and neither base
    await expect(unit.result.map(() => built.toSorted())).toBeOkWith([
      "stub farewell",
      "stub greeter",
    ]);
  });

  test("refuses a kind the runtime binds no module for", async () => {
    // GIVEN a runtime binding no unit module
    const runtime = testRuntime();

    // WHEN it is started with an override for a kind
    const app = start(
      overridden(rootOver(runtime), [], { unit: { user: [stubbing([], Greeter, "stub")] } }),
      quiet,
    );

    // THEN the boot is a defect naming the kind and the runtime
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message: '[core] unit override for kind "user", which runtime "test" binds no module for',
      }),
    );
  });

  test("refuses a port the kind's module does not provide", async () => {
    // GIVEN a kind module providing neither port
    const runtime = testRuntime("test", { unit: Module("Empty")({ provides: [], exports: [] }) });

    // WHEN it is started with an override for one of them
    const app = start(
      overridden(rootOver(runtime), [], { unit: { test: [stubbing([], Greeter, "stub")] } }),
      quiet,
    );

    // THEN the boot is the drift defect, naming the port and the kind
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message:
          '[core] unit override for port "UnitOverrideGreeter" in kind "test" with nothing to override — its module no longer provides it',
      }),
    );
  });

  test("refuses two overrides for one port in one kind at boot, not at the first fork", async () => {
    // GIVEN two nested overrides substituting the same port inside one kind
    const runtime = testRuntime("test", { unit: kindOf([]) });

    // WHEN the root is started
    const app = start(
      overridden(
        overridden(rootOver(runtime), [], {
          unit: { test: [stubbing([], Greeter, "first")] },
        }),
        [],
        { unit: { test: [stubbing([], Greeter, "second")] } },
      ),
      quiet,
    );

    // THEN the boot is a defect naming the port and the kind
    await expect(app.exited).toBeDefectWith(
      expect.objectContaining({
        message:
          '[core] two unit overrides registered for port "UnitOverrideGreeter" in kind "test"',
      }),
    );
  });

  test("refuses a module bound under two kinds, since a fork cannot tell them apart", async () => {
    // GIVEN a runtime binding one module under two kinds
    const kind = kindOf([]);
    const runtime = { ...testRuntime(), units: { user: kind, session: kind } };
    const root = Module("SharedRoot")({
      provides: [Provider(TestRuntimePort)({ inject: {}, value: runtime })],
      exports: [TestRuntimePort],
    });

    // WHEN one of the two kinds is overridden
    const app = start(
      overridden(root, [], { unit: { user: [stubbing([], Greeter, "stub")] } }),
      quiet,
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
