import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { enableTracing } from "./tracing.js";

describe("enableTracing", () => {
  it("turns the instrumentation on when it resolves", async ({ telemetry }) => {
    // GIVEN an instrumentation that loads
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
    const instrumentation = await enableTracing(telemetry.logger, load);

    // THEN it came on, and nothing was logged about it being absent
    expect({ enabled, returned: instrumentation !== undefined, ...telemetry.recorded() }).toEqual(
      expect.objectContaining({ enabled: true, returned: true, debug: [] }),
    );
  });

  it("says so at debug when the optional peer is not installed", async ({ telemetry }) => {
    // GIVEN a loader that cannot resolve `@prisma/instrumentation`
    const load = () => Promise.reject(new Error("Cannot find package"));

    // WHEN tracing is attempted
    const instrumentation = await enableTracing(telemetry.logger, load);

    // THEN it is skipped, and the skip is stated rather than silent — telemetry
    // you believe you have and do not is worse than none
    expect({ returned: instrumentation, ...telemetry.recorded() }).toEqual(
      expect.objectContaining({
        returned: undefined,
        debug: [
          expect.objectContaining({
            message: expect.stringContaining("@prisma/instrumentation is not installed"),
          }),
        ],
      }),
    );
  });
});
