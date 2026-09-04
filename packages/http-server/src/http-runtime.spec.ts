import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("httpRuntime", () => {
  it("does not throw when the server emits an error after binding", async ({
    serve,
    boundServer,
  }) => {
    // GIVEN a bound server — `net.Server` still emits `'error'` after listening,
    // on accept failures such as `EMFILE` under fd exhaustion
    await serve();

    // WHEN one is emitted
    // THEN it is absorbed — unhandled, it would reach the kernel's
    // `uncaughtException` handler and tear the application down
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

  it("names an out-of-range port as a configuration fault, before anything binds", async ({
    appOnPort,
  }) => {
    // GIVEN a port outside `0..65535`, pinned by the composition root
    // WHEN the application is started
    const exited = appOnPort(70_000).exited;

    // THEN the field's own rule refuses it at graph build — the pin is checked
    // exactly as `PORT=70000` would be — so it is `ConfigInvalid` (exit 78,
    // "the configuration is wrong") rather than a bind failure discovered
    // later by `listen`'s `ERR_SOCKET_BAD_PORT`. A DEFECT here would be the
    // regression: it bypasses the declared channel and exits 70.
    await expect(exited).toBeErrTagged(
      "ConfigInvalid",
      expect.objectContaining({ port: "HttpConfig" }),
    );
  });

  it("still models a port `listen` refuses when the config was not built by `Config`", async ({
    appOnUncheckedPort,
  }) => {
    // GIVEN a consumer binding `HttpConfig` itself — the route that skips
    // `Config.port`'s rule — with a port node validates and THROWS on
    // (`ERR_SOCKET_BAD_PORT`) rather than emitting `'error'`
    // WHEN the runtime is asked to bind it
    const exited = appOnUncheckedPort(70_000).exited;

    // THEN the synchronous throw is caught into the declared error channel. A
    // defect here would bypass `AsyncResult<Serving, RuntimeStartFailed>` and
    // exit 70 where a startup failure exits 1.
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
    // than asserts.
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

  it("binds PORT and HOST from the environment when nothing is pinned", async ({ configured }) => {
    // GIVEN a starter left to configure itself, and an environment naming the socket
    const { app, config } = configured({ PORT: "0", HOST: "127.0.0.1" });

    // WHEN the graph has been built and the runtime is serving
    const info = (await app.runtimeInfo()).get();

    // THEN the config was bound from the environment, parsed, and the runtime
    // published the ephemeral port the OS picked for it
    expect({ config: config(), listening: (info?.port ?? 0) > 0 }).toEqual({
      config: {
        port: 0,
        hostname: "127.0.0.1",
        bodyLimit: 1_048_576,
        corsOrigin: "",
        compression: false,
      },
      listening: true,
    });
  });

  it("pins what it is given and reads the rest from the environment", async ({ configured }) => {
    // GIVEN a starter with the port pinned, and a HOST in the environment
    const { app, config } = configured({ PORT: "9", HOST: "127.0.0.1" }, { port: 0 });

    // WHEN the graph has been built
    await app.runtimeInfo();

    // THEN the pin won over the environment for the port, and the environment
    // was still read for the host — explicit beats environment beats default,
    // per field
    expect(config()).toEqual({
      port: 0,
      hostname: "127.0.0.1",
      bodyLimit: 1_048_576,
      corsOrigin: "",
      compression: false,
    });
  });

  it("fails startup with ConfigInvalid for HttpConfig when PORT is not a port", async ({
    configured,
  }) => {
    // GIVEN an environment whose PORT the OS would refuse
    const { app } = configured({ PORT: "http" });

    // WHEN the application boots
    // THEN the modeled startup Err names the starter's config port and the variable
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpConfig",
        issues: [{ message: 'is not a whole number: "http"', path: ["PORT"] }],
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

  it("adopts a non-blank x-request-id as the trace id", async ({ serve, traced }) => {
    // GIVEN a caller that supplies a correlation id
    const { origin } = await serve(traced.handler);

    // WHEN it makes a request
    await fetch(origin, { headers: { "x-request-id": " abc-123 " } });

    // THEN the id crossed the process boundary, trimmed, so a line logged here
    // joins a trace that started elsewhere
    expect(traced.seen()).toEqual(["abc-123"]);
  });

  it("adopts the trace id inside a W3C traceparent, over x-request-id", async ({
    serve,
    traced,
  }) => {
    // GIVEN a caller that crossed another service, carrying both headers
    const { origin } = await serve(traced.handler);

    // WHEN it makes a request
    await fetch(origin, {
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "x-request-id": "abc-123",
      },
    });

    // THEN the traceparent's trace-id field won — the parent's span id
    // dropped, the trace joined
    expect(traced.seen()).toEqual(["4bf92f3577b34da6a3ce929d0e0e4736"]);
  });

  it("falls through a malformed or all-zero traceparent to x-request-id", async ({
    serve,
    traced,
  }) => {
    // GIVEN a caller whose traceparent carries the spec's own invalid value
    const { origin } = await serve(traced.handler);

    // WHEN it makes a request with the zero trace id beside a real request id
    await fetch(origin, {
      headers: {
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "x-request-id": "abc-123",
      },
    });

    // THEN nothing was half-adopted: the fallback vocabulary answered
    expect(traced.seen()).toEqual(["abc-123"]);
  });

  it("keeps its own minted trace id when x-request-id is blank", async ({ serve, traced }) => {
    // GIVEN a caller that sends the header but leaves it empty
    const { origin } = await serve(traced.handler);

    // WHEN it makes a request
    await fetch(origin, { headers: { "x-request-id": "" } });

    // THEN the minted id wins: `traceId` falls back to `meta.id` only when
    // nullish, and `""` is not — so a blank header would hand every request from
    // that caller the same empty id
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
    // window — new units the drain exists to stop admitting.
    await expect(held.head()).resolves.toContain("Connection: close");
  });

  it("sets the security headers on a served response", async ({ serve }) => {
    // GIVEN an app with the default security headers
    const { origin } = await serve();

    // WHEN a request is answered
    const response = await fetch(`${origin}/anything`);

    // THEN the defaults are on the response
    expect({
      nosniff: response.headers.get("x-content-type-options"),
      frame: response.headers.get("x-frame-options"),
      referrer: response.headers.get("referrer-policy"),
    }).toEqual({ nosniff: "nosniff", frame: "DENY", referrer: "no-referrer" });
  });

  it("sets them on the runtime's own 404 too", async ({ rpc }) => {
    // GIVEN an app whose oRPC handler declines a path
    const { origin } = await rpc();

    // WHEN an unmatched path is requested
    const response = await fetch(`${origin}/not-a-procedure`);

    // THEN the headers are there, on the path a handler plugin would never reach
    expect({
      status: response.status,
      nosniff: response.headers.get("x-content-type-options"),
    }).toEqual({ status: 404, nosniff: "nosniff" });
  });

  it("omits the security headers when securityHeaders is false", async ({ serve }) => {
    // GIVEN an app with the feature explicitly disabled
    const { origin } = await serve(undefined, false);

    // WHEN a request is answered
    const response = await fetch(origin);

    // THEN none of the default headers are present
    expect(response.headers.get("x-content-type-options")).toBeNull();
  });

  it("applies a custom securityHeaders record verbatim", async ({ serve }) => {
    // GIVEN an app whose starter was handed a record of its own
    const { origin } = await serve(undefined, {
      "permissions-policy": "geolocation=()",
      "x-frame-options": "SAMEORIGIN",
    });

    // WHEN a request is answered
    const response = await fetch(origin);

    // THEN exactly that record is on the response — the given value replaces
    // the defaults rather than extending them
    expect({
      policy: response.headers.get("permissions-policy"),
      frame: response.headers.get("x-frame-options"),
      nosniff: response.headers.get("x-content-type-options"),
    }).toEqual({ policy: "geolocation=()", frame: "SAMEORIGIN", nosniff: null });
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

  it("counts a stream open when the drain begins as completed, not abandoned", async ({
    streaming,
  }) => {
    // GIVEN a stream that has delivered at least one event
    const { app, origin } = await streaming.serve();
    const stream = await streaming.subscribe(origin);
    await vi.waitUntil(() => stream.frames() >= 2);

    // WHEN the drain begins
    app.requestDrain();

    // THEN the runtime ended the stream at beat 3's start and the kernel saw
    // its unit close inside the budget. Waiting for `finish` instead — the
    // keep-alive branch — would hold it to the deadline and report it abandoned.
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });

  it("resets a stream rather than ending it cleanly, so a client reconnects", async ({
    streaming,
  }) => {
    // GIVEN a stream that has delivered at least one event
    const { app, origin } = await streaming.serve();
    const stream = await streaming.subscribe(origin);
    await vi.waitUntil(() => stream.frames() >= 2);

    // WHEN the drain begins
    app.requestDrain();

    // THEN the body ends in a socket error. A clean end is read by oRPC's
    // client as the iterator finishing, and it never reconnects; a reset is
    // what both it and a bare `EventSource` treat as "reconnect".
    await expect(stream.ended).resolves.toBe("reset");
  });

  it("releases the stream's procedure when it resets the stream", async ({ streaming }) => {
    // GIVEN a stream whose generator is inside its loop
    const { app, origin, released } = await streaming.serve();
    const stream = await streaming.subscribe(origin);
    await vi.waitUntil(() => stream.frames() >= 2);

    // WHEN the drain begins and the stream is reset
    app.requestDrain();
    await stream.ended;
    await vi.waitUntil(released);

    // THEN the generator's `finally` ran: an application's cleanup is reached
    // through oRPC's own signal, which the reset aborts
    expect(released()).toBe(true);
  });

  it("serves a GET on a stream procedure, which is the only request an EventSource can send", async ({
    streaming,
  }) => {
    // GIVEN a router with an event-iterator procedure
    const { origin } = await streaming.serve();

    // WHEN a browser-shaped GET arrives for it
    const response = await fetch(`${origin}/rpc/ticks`, {
      headers: { accept: "text/event-stream" },
    });
    await response.body?.cancel();

    // THEN it is the stream, not the runtime's 404
    expect({ status: response.status, type: response.headers.get("content-type") }).toEqual({
      status: 200,
      type: expect.stringContaining("text/event-stream"),
    });
  });

  it("still refuses a GET on a procedure that does not stream", async ({ streaming }) => {
    // GIVEN the same router, whose other procedure answers a value
    const { origin } = await streaming.serve();

    // WHEN a GET arrives for the plain procedure
    const response = await fetch(`${origin}/rpc/hello`);

    // THEN oRPC declines it and the runtime answers its own 404: GET stays
    // closed on everything a browser has no reason to GET
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: { error: "NotFound" },
    });
  });

  it("serves a fragments-only graph, with no oRPC router anywhere", async ({ serveAnswerer }) => {
    // GIVEN a graph composing the socket half and one bare answerer — no
    // router, no oRPC, which `http()` would have forced
    const { origin } = await serveAnswerer("/ui", "hello from a fragment");

    // WHEN the answerer's mount point is requested
    const response = await fetch(`${origin}/ui`);

    // THEN it was served: the socket half stands on its own
    expect(await response.text()).toBe("hello from a fragment");
  });

  it("forks the anonymous unit module once per handled request, and tears it down", async ({
    scoped,
  }) => {
    // GIVEN an app bound to an anonymous unit module
    const { origin, counts } = await scoped.serve();

    // WHEN two procedures are answered — waited out WHILE the app is still
    // running, so a scope only closed by the application's own shutdown
    // cannot pass this test
    await fetch(`${origin}/rpc/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await fetch(`${origin}/rpc/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await vi.waitUntil(() => counts().stops === 2);

    // THEN the module was built and torn down once per request
    expect(counts()).toEqual({ builds: 2, stops: 2 });
  });

  it("does not fork for a path no answerer handles", async ({ scoped }) => {
    // GIVEN the same app
    const { app, origin, counts } = await scoped.serve();

    // WHEN a path outside every answerer is requested, and the app stops
    await fetch(`${origin}/nowhere`);
    app.stop();
    await app.exited;

    // THEN nothing was forked: the fork is the answerer's, for a request it handles
    expect(counts()).toEqual({ builds: 0, stops: 0 });
  });
});
