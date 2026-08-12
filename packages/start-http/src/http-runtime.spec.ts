import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("httpRuntime", () => {
  it("does not throw when the server emits an error after binding", async ({
    serve,
    boundServer,
  }) => {
    // GIVEN a bound server — `net.Server` still emits `'error'` after listening,
    // on accept failures such as `EMFILE` under fd exhaustion
    await serve();

    // WHEN one is emitted
    // THEN it is absorbed. Unhandled, it would reach the kernel's
    // `uncaughtException` handler and tear the whole application down over a
    // transient fault in the transport.
    expect(() => boundServer().emit("error", new Error("accept"))).not.toThrow();
  });

  it("publishes the port it actually bound", async ({ serve }) => {
    // GIVEN a runtime asked for an ephemeral port
    const { app } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the real port, which is the entire reason `port: 0` is usable
    await expect(info).toBeOkWith({ port: expect.any(Number) });
  });

  it("reports a port it cannot bind", async ({ occupied }) => {
    // GIVEN a port already taken by another listener
    // WHEN a runtime is asked to bind it
    const exited = occupied.appOnTakenPort.exited;

    // THEN the application never starts, and the failure is the kernel's own
    // modeled error rather than an unmodelled defect
    await expect(exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "http" }),
    );
  });

  it("reports an out-of-range port as a modeled failure, not a defect", async ({ appOnPort }) => {
    // GIVEN a port node rejects synchronously — `listen` validates the range
    // itself and THROWS `ERR_SOCKET_BAD_PORT` rather than emitting `'error'`
    // WHEN the runtime is asked to bind it
    const exited = appOnPort(70_000).exited;

    // THEN it lands in the declared error channel. A defect here would bypass
    // `AsyncResult<Serving, RuntimeStartFailed>` and exit 70 where a startup
    // failure exits 1.
    await expect(exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "http" }),
    );
  });
});
