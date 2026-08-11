import { isInferableError, ORPCError } from "@orpc/client";
import { fromSafePromise, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { OrderApiModule } from "./module.js";
import { it } from "./test-fixtures.js";

describe("orpcRuntime", () => {
  it("carries a real oRPC call through to the DI-wired use case", async ({ serve, clientFor }) => {
    // GIVEN the real composition root, served on an ephemeral port
    const client = await clientFor(serve(OrderApiModule));

    // WHEN two calls go over the wire
    const placed = await client.orders.place({ id: "o-1", quantity: 2 });
    // A second request, a second unit — and the same database, because the
    // application scope is opened once by the kernel and only the request
    // scope is forked per call.
    const found = await client.orders.find({ id: "o-1" });

    // THEN both reached the use case behind the transport
    expect(placed).toBeOkWith({ id: "o-1", quantity: 2 });
    expect(found).toBeOkWith({ id: "o-1", quantity: 2 });
  });

  it("publishes the bound port on Serving.info", async ({ serve }) => {
    // GIVEN a runtime that bound `port: 0`
    const app = serve(OrderApiModule);

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN the port it actually got is readable, with no hook of its own
    await expect(info).toBeOkWith({ port: expect.any(Number), prefix: "/rpc" });
  });

  it("turns a domain Err into a typed, inferable ORPCError — a value, not a thrown 500", async ({
    serve,
    clientFor,
  }) => {
    // GIVEN an order already placed
    const client = await clientFor(serve(OrderApiModule));
    await expect(client.orders.place({ id: "o-1", quantity: 1 })).toBeOk();

    // WHEN the same id is placed again, and an invalid quantity is placed
    const conflict = await client.orders.place({ id: "o-1", quantity: 1 });
    const invalid = await client.orders.place({ id: "o-2", quantity: 0 });

    // THEN the `Err` channel, not the defect one: the client got a value back
    expect(conflict).toBeErr();
    if (conflict.isErr()) {
      expect(conflict.error).toBeInstanceOf(ORPCError);
      expect(conflict.error.code).toBe("CONFLICT");
      expect(conflict.error.data).toEqual({ id: "o-1" });
      // What "typed end to end" means at runtime: oRPC marks a returned,
      // declared error inferable, which is why it is an `Err` and not a
      // `Defect` collapsed to INTERNAL_SERVER_ERROR.
      expect(isInferableError(conflict.error)).toBe(true);
    }

    expect(invalid).toBeErr();
    if (invalid.isErr()) {
      expect(invalid.error.code).toBe("INVALID_QUANTITY");
      expect(invalid.error.data).toEqual({ id: "o-2" });
    }

    // Each code is reachable from the client's own exhaustive match — the
    // mirror of the `mapErrCases` that produced it.
    const named = invalid.match({
      ok: () => "ok",
      errCases: (matcher) =>
        matcher
          .with({ code: "INVALID_QUANTITY" }, (error) => error.code)
          .with({ code: "CONFLICT" }, (error) => error.code),
      defect: () => "defect",
    });
    expect(named).toBe("INVALID_QUANTITY");
  });

  it("collapses a Defect to INTERNAL_SERVER_ERROR and keeps serving", async ({
    serve,
    clientFor,
    apiWith,
  }) => {
    // GIVEN a repository whose failure nobody modelled: no `qualify` triaged
    // it, so it is a defect and never reaches the contract's declared error map
    const app = serve(
      apiWith({
        save: (order) => OkAsync(order),
        find: () => fromSafePromise(Promise.reject(new Error("the database is on fire"))),
      }),
    );
    const client = await clientFor(app);

    // WHEN a call reaches it
    const result = await client.orders.find({ id: "o-1" });

    // THEN the raw cause does NOT leak over the wire; oRPC collapses it, and
    // the non-inferable result lands back in the defect channel
    expect(result).toBeDefectWith(expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }));
    if (result.isDefect()) expect(isInferableError(result.cause)).toBe(false);

    // …and a defect is not a crash: the process is still serving.
    expect(app.phase()).toBe("serving");
    await expect(client.orders.place({ id: "o-1", quantity: 1 })).toBeOk();
  });

  it("runs each call in its own unit, with its own trace id", async ({
    serve,
    clientFor,
    tapped,
  }) => {
    // GIVEN the real graph with the very `Logger` instance the use cases write to
    const client = await clientFor(serve(tapped.api));

    // WHEN two calls are served
    await expect(client.orders.place({ id: "o-1", quantity: 1 })).toBeOk();
    await expect(client.orders.place({ id: "o-2", quantity: 1 })).toBeOk();

    // THEN two calls, two interactor lines plus two request-scope teardown
    // lines, carrying two distinct trace ids and never the out-of-unit `[-]`
    const traces = tapped.traces();
    expect(traces).toHaveLength(4);
    expect(new Set(traces).size).toBe(2);
    expect(traces).not.toContain("[-]");
  });

  it("lets an in-flight call finish while draining", async ({ serve, clientFor, gate }) => {
    // GIVEN a call held open inside the repository
    const app = serve(gate.api);
    const client = await clientFor(app);
    const inFlight = client.orders.find({ id: "o-1" });
    await gate.arrived;

    // WHEN the drain starts and the call is released only once the phase moved.
    // The drain samples `inFlightAtStart` in the same synchronous turn that
    // advances the phase, so releasing afterwards is what makes the report
    // below exact rather than racy.
    app.requestDrain();
    await expect.poll(() => app.phase()).toBe("draining");
    gate.release();

    // THEN the call completed, and the drain report says so
    await expect(inFlight).toBeOkWith({ id: "o-1", quantity: 1 });
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  it("reports a call still hung at the deadline as abandoned", async ({
    serve,
    clientFor,
    gate,
  }) => {
    // GIVEN a call held open, and a drain with no time to give it
    const app = serve(gate.api, { drainTimeoutMs: 0 });
    const client = await clientFor(app);
    const hung = client.orders.find({ id: "o-1" });
    await gate.arrived;

    // WHEN the drain starts and the call is never released
    app.requestDrain();

    // THEN the unit still open at the deadline is counted abandoned
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
    // `stop` destroyed the socket under the abandoned call, so the client's own
    // `Result` is a defect — consumed here rather than left floating. The cause
    // is the fetch stack's own transport error, whose exact shape is not ours.
    await expect(hung).toBeDefectWith(expect.any(Error));
  });

  it("answers probes alongside the runtime, and goes unready on drain", async ({
    serve,
    clientFor,
    probesFor,
    statusOf,
    gate,
  }) => {
    // GIVEN the runtime and the kernel's probe server both bound
    const app = serve(gate.api, { probes: { port: 0 } });
    const probes = await probesFor(app);
    const client = await clientFor(app);

    expect(await statusOf(`${probes}/livez`)).toBe(200);
    expect(await statusOf(`${probes}/readyz`)).toBe(200);
    expect(app.ready()).toBe(true);

    // WHEN a call is in flight and the drain starts
    const inFlight = client.orders.find({ id: "o-1" });
    await gate.arrived;
    app.requestDrain();

    // THEN readiness goes false before liveness does. The TRANSITION is
    // asserted through `ready()`, which is synchronously readable — polling
    // `/readyz` for it races the app exiting out from under the probe server,
    // and `expect.poll` fails outright when its callback throws. The endpoint is
    // then read exactly once, in a state that is stable because the held call
    // keeps the drain (and the process) alive.
    await expect.poll(() => app.ready()).toBe(false);
    expect(await statusOf(`${probes}/readyz`)).toBe(503);
    expect(await statusOf(`${probes}/livez`)).toBe(200);

    gate.release();
    await expect(inFlight).toBeOk();
    await expect(app.exited).toBeOk();
  });
});
