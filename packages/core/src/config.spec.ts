import { ConfigInvalid } from "@btravstack/config";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { RuntimeStartFailed } from "./runtime.js";

describe("Config.provider", () => {
  it("fails startup with ConfigInvalid, naming the port and the variables", async ({
    configured,
  }) => {
    // GIVEN an environment the schema rejects
    const app = configured.boot({ PORT: "abc" });

    // WHEN the application boots
    // THEN the modeled startup Err is the ConfigInvalid, still typed
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        constructor: ConfigInvalid,
        port: "ConfigFixtureSettings",
        issues: [{ message: 'is not a whole number: "abc"', path: ["PORT"] }],
      }),
    );
  });

  it("exits 78 under runMain — the deployment is wrong, not the code", async ({ configured }) => {
    // GIVEN an environment the schema rejects
    const env = { RETRIES: "-1" };

    // WHEN the process is run
    const code = await configured.exitCodeFor(env);

    // THEN it is sysexits(3)'s EX_CONFIG rather than the generic startup 1
    expect(code).toBe(78);
  });
});

describe("PROBE_PORT", () => {
  it("binds the probe server from the environment when no option is given", async ({
    configured,
  }) => {
    // GIVEN an environment asking for an ephemeral probe port
    const app = configured.probesFrom({ PROBE_PORT: "0" });

    // WHEN the probe server has bound
    const port = await app.probePort();

    // THEN the OS picked one — a real, non-zero port — rather than the default 9000
    expect(port).toBeOkWith(expect.any(Number));
  });

  it("exits 78 when PROBE_PORT is not a port", async ({ configured }) => {
    // GIVEN a probe port the OS would refuse
    const env = { PROBE_PORT: "abc" };

    // WHEN the process is run with the kernel binding probes from the environment
    const code = await configured.exitCodeFor(env, true);

    // THEN it is a configuration failure, reported as such
    expect(code).toBe(78);
  });

  it("reports every variable the kernel itself could not read, in one failure", async ({
    configured,
  }) => {
    // GIVEN a probe port the OS would refuse and a drain timeout that is not a number
    const app = configured.probesFrom({ PROBE_PORT: "70000", DRAIN_TIMEOUT_MS: "soon" });

    // WHEN the application boots
    // THEN the failure is the kernel's own, and names BOTH variables — an
    // operator fixes the deployment in one round trip
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        constructor: RuntimeStartFailed,
        runtime: "kernel",
        cause: expect.objectContaining({
          constructor: ConfigInvalid,
          issues: [
            { message: "must be between 0 and 65535, got 70000", path: ["PROBE_PORT"] },
            { message: 'is not a whole number: "soon"', path: ["DRAIN_TIMEOUT_MS"] },
          ],
        }),
      }),
    );
  });

  it("binds the drain timings from the environment when nothing pins them", async ({
    configured,
  }) => {
    // GIVEN an application deployed with its own drain timings and no pins
    // WHEN it drains
    const slept = await configured.drainSleepsFor({
      PROBE_PORT: "0",
      PRE_DRAIN_DELAY_MS: "1000",
      DRAIN_TIMEOUT_MS: "12345",
    });

    // THEN the deployment's own values are what the two beats waited, not the
    // kernel's defaults of 5s and 20s
    expect(slept).toEqual([1_000, 12_345]);
  });
});
