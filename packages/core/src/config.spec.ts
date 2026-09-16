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
    // GIVEN an environment asking for an ephemeral probe port on loopback —
    // the interface is pinned because the shipped default is the wildcard, and
    // a suite has no business listening on every interface of its machine
    const app = configured.probesFrom({ PROBE_PORT: "0", PROBE_HOST: "127.0.0.1" });

    // WHEN the probe server has bound
    const port = await app.probePort();

    // THEN the OS picked one — a real, non-zero port — rather than the default 9000
    expect(port).toBeOkWith(expect.any(Number));
  });

  it("binds the probe interface from PROBE_HOST, and reports a bind it cannot make", async ({
    configured,
  }) => {
    // GIVEN an address this machine does not have — TEST-NET-1, which RFC 5737
    // reserves precisely so nothing can be assigned it. `PROBE_HOST` is a
    // string, so it is the BIND that must refuse it rather than the schema,
    // which is only true if the variable reaches `listen` at all.
    const app = configured.probesFrom({ PROBE_PORT: "0", PROBE_HOST: "192.0.2.1" });

    // WHEN the kernel tries to bind it
    // THEN it is a modeled startup failure naming the probe server, carrying
    // the operating system's own refusal
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "probes" }),
    );
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

  it("still reports a bad drain timing when the probe server is off", async ({ configured }) => {
    // GIVEN probes disabled, so nothing reads PROBE_PORT, and a malformed
    // DRAIN_TIMEOUT_MS
    const app = configured.withoutProbes({ DRAIN_TIMEOUT_MS: "soon" });

    // WHEN the application boots
    // THEN the kernel still refuses: the read covers the drain timings, not
    // only the probe port, so `probes: false` cannot swallow it
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        constructor: RuntimeStartFailed,
        runtime: "kernel",
        cause: expect.objectContaining({
          constructor: ConfigInvalid,
          issues: [{ message: 'is not a whole number: "soon"', path: ["DRAIN_TIMEOUT_MS"] }],
        }),
      }),
    );
  });

  it("binds the drain timings from the environment when nothing pins them", async ({
    configured,
  }) => {
    // GIVEN an application deployed with its own shutdown timings and no pins
    // WHEN it drains
    const slept = await configured.drainSleepsFor({
      PROBE_PORT: "0",
      PRE_DRAIN_DELAY_MS: "1000",
      DRAIN_TIMEOUT_MS: "12345",
      STOP_TIMEOUT_MS: "4321",
    });

    // THEN the deployment's own values are what each wait took, not the
    // kernel's defaults of 5s, 20s and 5s — in the order the shutdown walks
    // them: the pre-drain delay, the drain deadline, then the stop's
    expect(slept).toEqual([1_000, 12_345, 4_321]);
  });
});
