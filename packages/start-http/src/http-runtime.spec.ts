import { describe, expect, vi } from "vitest";

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

  it("keeps the unit open until the response is on the wire", async ({ serve, gate }) => {
    // GIVEN a request whose handler is held open inside the application
    const { app, origin } = await serve(gate.handler);
    const inFlight = fetch(origin);
    await gate.arrived;

    // WHEN the drain begins while it is still unanswered, and the handler is
    // released only once the phase has moved. `vi.waitUntil` synchronises rather
    // than asserts — the drain samples `inFlightAtStart` in the same synchronous
    // turn that advances the phase.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();
    await inFlight;

    // THEN the kernel counted it as one unit that COMPLETED. Closing the unit on
    // the handler's promise instead would let a response still being written
    // race `Serving.stop` tearing the socket down.
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });

  it("answers 404 when the handler declines to respond", async ({ serve }) => {
    // GIVEN a handler that resolves without writing — oRPC's `matched: false`
    // path, which is how a router says "not mine"
    const { origin } = await serve(() => Promise.resolve({ matched: false }));

    // WHEN a request arrives
    const response = await fetch(origin);

    // THEN the client is answered rather than left hanging until the drain
    // deadline, and the unit closes with it
    expect(response.status).toBe(404);
  });

  it("answers 500 when the handler fails", async ({ serve }) => {
    // GIVEN a handler whose promise rejects
    const { origin } = await serve(() => Promise.reject(new Error("boom")));

    // WHEN a request arrives
    const response = await fetch(origin);

    // THEN a failure cannot strand a unit either
    expect(response.status).toBe(500);
  });

  it("adopts a non-blank x-request-id as the trace id", async ({ serve, traced }) => {
    // GIVEN a caller that supplies a correlation id
    const { origin } = await serve(traced.handler);

    // WHEN it makes a request
    await fetch(origin, { headers: { "x-request-id": " abc-123 " } });

    // THEN the id crossed the process boundary, trimmed, so a line logged here
    // joins a trace that started elsewhere
    expect(traced.seen()).toEqual(["abc-123"]);
  });

  it("keeps its own minted trace id when x-request-id is blank", async ({ serve, traced }) => {
    // GIVEN a caller that sends the header but leaves it empty
    const { origin } = await serve(traced.handler);

    // WHEN it makes a request
    await fetch(origin, { headers: { "x-request-id": "" } });

    // THEN the minted id wins. `traceId` falls back to `meta.id` only when
    // nullish, and `""` is not — so a blank header would hand every request from
    // that caller the same empty id, defeating the ambient record exactly as a
    // route template would.
    expect(traced.seen()).toEqual([expect.not.stringMatching(/^$/u)]);
  });
});
