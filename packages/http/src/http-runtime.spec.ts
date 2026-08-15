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

  it("answers 500 when the handler throws before returning a promise", async ({ serve }) => {
    // GIVEN a handler that throws synchronously — not a rejected promise, so
    // there is nothing `answer`'s own try/catch can reach. The throw escapes
    // the unit's work callback itself, which the kernel folds to a Defect.
    const { origin } = await serve(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject under test
      throw new Error("boom");
    });

    // WHEN a request arrives
    const response = await fetch(origin);

    // THEN the unit's defect path still answers it — the same path a
    // `StartOptions.unit` construction failure takes
    expect(response.status).toBe(500);
  });

  it("resets the connection when the handler throws with headers already on the wire", async ({
    serve,
  }) => {
    // GIVEN a handler that flushes its headers and then throws synchronously —
    // no status left to write, and a body the client is still waiting on
    const { origin } = await serve((_request, response) => {
      response.writeHead(200, { "content-length": "2" });
      response.flushHeaders();
      // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject under test
      throw new Error("boom");
    });

    // WHEN a request arrives
    // THEN the one courtesy left — killing the socket rather than leaving the
    // client to hang on a body that never comes — is what it observes
    await expect(fetch(origin).then((response) => response.text())).rejects.toThrow();
  });

  it("closes the unit when the client hung up before its work began", async ({
    serve,
    slowUnit,
    boundServer,
  }) => {
    // GIVEN a unit module that builds only when released, and a request whose
    // client gives up while it is building — the server has already seen the
    // response close by the time the unit's work runs
    const { app, origin } = await serve(undefined, slowUnit.module);
    const hungUp = new Promise<void>((done) => {
      boundServer().once("request", (_request, response) => response.once("close", () => done()));
    });
    const controller = new AbortController();
    const abandonedByClient = fetch(origin, { signal: controller.signal }).catch(() => undefined);
    await slowUnit.arrived;
    controller.abort();
    await hungUp;

    // WHEN the unit is released and its work runs to completion
    slowUnit.release();
    await abandonedByClient;
    await new Promise<void>((tick) => setImmediate(tick));

    // THEN a drain finds nothing in flight: the unit closed on the response that
    // was already closed, rather than waiting for a `'close'` that had fired
    app.requestDrain();
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 0, completed: 0, abandoned: 0 } }),
    );
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

  it("closes a keep-alive connection that was busy when the drain began", async ({
    serve,
    gate,
    keepAlive,
  }) => {
    // GIVEN a keep-alive connection whose request is held open, so
    // `closeIdleConnections()` cannot reach it
    const { app, origin } = await serve(gate.handler);
    const held = await keepAlive.call(origin);
    await gate.arrived;

    // WHEN the drain has genuinely stopped accepting, and the request then
    // completes on that still-open connection
    app.requestDrain();
    await keepAlive.stoppedAccepting(origin);
    gate.release();

    // THEN the response tells the client the connection is finished. Left
    // `keep-alive`, node serves further requests down it for the whole drain
    // window — new units the drain exists to stop admitting, and ones the
    // deadline then reports abandoned.
    await expect(held.head()).resolves.toContain("Connection: close");
  });

  it("ends the socket after a response whose headers were already on the wire when the drain began", async ({
    serve,
    streamedGate,
    keepAlive,
  }) => {
    // GIVEN a response that already flushed its headers before the drain
    // begins — there is no `Connection` header left to change, so
    // `retire`'s other branch has nothing to do
    const { app, origin } = await serve(streamedGate.handler);
    const held = await keepAlive.call(origin);
    await streamedGate.arrived;

    // WHEN the drain marks it while it is still open, and it completes on
    // that same connection afterwards
    app.requestDrain();
    await keepAlive.stoppedAccepting(origin);
    streamedGate.release();

    // THEN node ends the socket once the response finishes anyway — the
    // guarantee holds for a response caught mid-stream, not only one caught
    // before its first byte
    await expect(held.closed()).resolves.toBeUndefined();
  });
});
