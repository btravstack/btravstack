import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { loadPrismaInstrumentation } from "./tracing.js";

describe("loadPrismaInstrumentation", () => {
  it("enables the instrumentation when the optional peer is installed", async ({ logs }) => {
    // GIVEN a loader that resolves an instrumentation
    let enabled = false;
    const load = () =>
      Promise.resolve(
        class {
          enable(): void {
            enabled = true;
          }
          disable(): void {}
        },
      );

    // WHEN tracing is enabled
    const instrumentation = await loadPrismaInstrumentation(logs.logger, load);

    // THEN it came on, and nothing was said about it being absent
    expect({ enabled, returned: instrumentation !== undefined, debug: logs.debug() }).toEqual({
      enabled: true,
      returned: true,
      debug: [],
    });
  });

  it("reports the skip rather than passing silently", async ({ logs }) => {
    // GIVEN a loader that cannot resolve `@prisma/instrumentation`
    const load = () => Promise.reject(new Error("Cannot find package"));

    // WHEN tracing is attempted
    const instrumentation = await loadPrismaInstrumentation(logs.logger, load);

    // THEN it is skipped, and the skip is stated rather than silent —
    // telemetry you believe you have and do not is worse than none. `debug`,
    // not `error`: a missing OPTIONAL peer is a choice rather than a fault
    expect({ returned: instrumentation, debug: logs.debug() }).toEqual({
      returned: undefined,
      debug: [expect.stringContaining("@prisma/instrumentation is not installed")],
    });
  });
});
