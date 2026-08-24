import { ORPCError } from "@orpc/client";
import request from "supertest";
import { Ok } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./test-fixtures.js";

describe("order-api", () => {
  it("carries a real oRPC call through to the DI-wired use case", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN the real composition root, served on an ephemeral port
    const client = await clientFor(serve(api));

    // WHEN a call goes over the wire
    // THEN it reached the use case behind the transport
    await expect(
      client.orders.place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 }),
    ).toBeOkWith({
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 2,
    });
  });

  it("serves every call from the one application scope, so a write outlives its request", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN the real composition root, served on an ephemeral port
    const client = await clientFor(serve(api));

    // WHEN a second request looks up what the first wrote. A second request is
    // a second unit — and the same database, because the application scope is
    // opened once by the kernel and only the request scope is forked per call.
    const found = await client.orders
      .place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 })
      .flatMap(() => client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" }));

    // THEN the write is visible to the read
    expect(found).toBeOkWith({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 });
  });

  it("publishes the bound port on Serving.info", async ({ serve, api }) => {
    // GIVEN a runtime that bound `port: 0`
    const app = serve(api);

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN the port it actually got is readable, with no hook of its own
    await expect(info).toBeOkWith({ port: expect.any(Number) });
  });

  it("turns a domain Err into a typed, inferable CONFLICT — a value, not a thrown 500", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN an order already placed
    const client = await clientFor(serve(api));

    // WHEN the same id is placed again — chained, so the first call's `Result`
    // is consumed and a failure there cannot be mistaken for the conflict
    const conflict = await client.orders
      .place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 1 })
      .flatMap(() =>
        client.orders.place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 1 }),
      );

    // THEN the `Err` channel, not the defect one: the client got a value back.
    // `constructor` is read through the prototype chain, so the one assertion
    // also pins the class; `inferable` is the other half of
    // `isInferableError`, and what "typed end to end" means at runtime — oRPC
    // marks a returned, declared error inferable, which is why this is an `Err`
    // and not a `Defect` collapsed to INTERNAL_SERVER_ERROR.
    expect(conflict).toBeErrWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "CONFLICT",
        data: { id: "0199a1e0-0000-7000-8000-000000000001" },
        inferable: true,
      }),
    );
  });

  it("turns a rejected invariant into a typed, inferable INVALID_QUANTITY", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN the real composition root, served on an ephemeral port
    const client = await clientFor(serve(api));

    // WHEN a quantity the domain rejects is placed
    const invalid = await client.orders.place({
      id: "0199a1e0-0000-7000-8000-000000000002",
      quantity: 0,
    });

    // THEN the second declared code crosses the wire the same way
    expect(invalid).toBeErrWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "INVALID_QUANTITY",
        data: { id: "0199a1e0-0000-7000-8000-000000000002" },
        inferable: true,
      }),
    );
  });

  it("lets the client match that error channel exhaustively, by code", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN an error the contract declares
    const client = await clientFor(serve(api));
    const invalid = await client.orders.place({
      id: "0199a1e0-0000-7000-8000-000000000002",
      quantity: 0,
    });

    // WHEN the channel is folded — the mirror of the `mapErrCases` that
    // produced it, with no wildcard to fall back on. All three codes are named
    // and grouped into one arm because they share a handler, which is what a
    // wildcard would look like if it were still a decision
    const named = invalid.match({
      ok: () => "WRONGLY ACCEPTED",
      errCases: (matcher) =>
        matcher.with(
          { code: "INVALID_QUANTITY" },
          { code: "BAD_REQUEST" },
          { code: "CONFLICT" },
          (error) => error.code,
        ),
      defect: () => "defect",
    });

    // THEN each code is reachable from the client's own exhaustive match
    expect(named).toBe("INVALID_QUANTITY");
  });

  it("collapses a Defect to INTERNAL_SERVER_ERROR without leaking the cause", async ({
    serve,
    clientFor,
    unmodelled,
  }) => {
    // GIVEN a repository whose failure nobody modelled
    const client = await clientFor(serve(unmodelled));

    // WHEN a call reaches it
    const result = await client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" });

    // THEN the raw cause does NOT leak over the wire; oRPC collapses it, and
    // the non-inferable result lands back in the defect channel. `inferable`
    // is asserted here rather than behind an `if (result.isDefect())`, which
    // would silently not run at all if the channel were ever the other one.
    expect(result).toBeDefectWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "INTERNAL_SERVER_ERROR",
        inferable: false,
        message: expect.not.stringContaining("on fire"),
      }),
    );
  });

  it("keeps serving after a defect, because a defect is not a crash", async ({
    serve,
    clientFor,
    unmodelled,
  }) => {
    // GIVEN a repository whose failure nobody modelled
    const app = serve(unmodelled);
    const client = await clientFor(app);

    // WHEN a call blows up and another one follows it. The defect is consumed
    // here rather than asserted — it is the subject of the test above; what
    // this one asks is what the process does next.
    const served = await client.orders
      .find({ id: "0199a1e0-0000-7000-8000-000000000001" })
      .recoverDefect(() => Ok("defected" as const))
      .flatMap(() =>
        client.orders.place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 1 }),
      )
      .map(() => app.phase());

    // THEN the next call was served, by a process still in the serving phase
    expect(served).toBeOkWith("serving");
  });

  it("runs each call in its own unit, with its own trace id", async ({
    serve,
    clientFor,
    recording,
  }) => {
    // GIVEN the real graph's composition, recording every line its logger writes
    const client = await clientFor(serve(recording.api));

    // WHEN two calls are served — chained, so neither `Result` is dropped
    const served = await client.orders
      .place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 1 })
      .flatMap(() =>
        client.orders.place({ id: "0199a1e0-0000-7000-8000-000000000002", quantity: 1 }),
      );

    // THEN two calls, each writing a controller line, an interactor line and a
    // request-scope teardown line, carrying two distinct trace ids and never
    // one written outside a unit — read off the line's own `unit` field, which is what the logger
    // stamps from `currentUnit()` per call
    const traced = served
      .map(() => recording.lines())
      .map((lines) => ({
        lines: lines.length,
        distinct: new Set(lines.map((line) => line.unit?.traceId)).size,
        outOfUnit: lines.filter((line) => line.unit === undefined).length,
      }));

    expect(traced).toBeOkWith({ lines: 6, distinct: 2, outOfUnit: 0 });
  });

  it("lets an in-flight call finish while draining", async ({ serve, clientFor, gate }) => {
    // GIVEN a call held open inside the repository
    const app = serve(gate.api);
    const client = await clientFor(app);
    const inFlight = client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" });
    await gate.arrived;

    // WHEN the drain starts and the call is released only once the phase moved.
    // `vi.waitUntil` synchronises rather than asserts — the drain samples
    // `inFlightAtStart` in the same synchronous turn that advances the phase,
    // so releasing afterwards is what makes the report exact rather than racy.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the call ran to completion
    await expect(inFlight).toBeOkWith({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 1 });
  });

  it("counts the finished call as completed in the drain report", async ({
    serve,
    clientFor,
    gate,
  }) => {
    // GIVEN a call held open inside the repository
    const app = serve(gate.api);
    const client = await clientFor(app);
    const inFlight = client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" });
    await gate.arrived;

    // WHEN the drain starts and the call is released only once the phase moved
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the drain report says the unit finished — read through the
    // in-flight call, so its own `Result` is consumed and a call that failed
    // could not be reported as completed
    const report = await inFlight.flatMap(() => app.exited);

    expect(report).toBeOkWith(
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
    const hung = client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" });
    await gate.arrived;

    // WHEN the drain starts and the call is never released
    app.requestDrain();

    // THEN the unit still open at the deadline is counted abandoned. The hung
    // call settles only once `stop` destroys the socket under it, which is
    // after the report — so it is consumed by the `flatTap`, in that order,
    // and asserted on its own in the test below.
    const report = await app.exited.flatTap(() => hung.recoverDefect(() => Ok()));

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
  });

  it("surfaces the socket destroyed under an abandoned call as a defect", async ({
    serve,
    clientFor,
    gate,
  }) => {
    // GIVEN a call held open, and a drain with no time to give it
    const app = serve(gate.api, { drainTimeoutMs: 0 });
    const client = await clientFor(app);
    const hung = client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" });
    await gate.arrived;

    // WHEN the drain starts and the call is never released
    app.requestDrain();

    // THEN `stop` destroyed the socket under it, so the client's own `Result`
    // is a defect — consumed here rather than left floating. The cause is the
    // fetch stack's own transport error, whose exact shape is not ours.
    await expect(hung).toBeDefectWith(expect.any(Error));
  });

  it("answers both probes while the runtime serves", async ({ serve, probesFor, gate }) => {
    // GIVEN the runtime and the kernel's probe server both bound
    const app = serve(gate.api, { probes: { port: 0 } });
    const probes = await probesFor(app);
    // The probe server binds BEFORE the graph is built, and answers 503 until
    // the runtime is serving — correctly. `runtimeInfo()` settles when it is,
    // which is the barrier every other test here crosses by asking for a port.
    await app.runtimeInfo();

    // WHEN both endpoints are read while serving — supertest, because the
    // probes are the one surface with no contract for the typed client
    const probed = {
      livez: (await probes.get("/livez")).status,
      readyz: (await probes.get("/readyz")).status,
      ready: app.ready(),
    };

    // THEN the app reports itself live and ready, on the endpoint and on the
    // accessor the kernel exposes for it
    expect(probed).toEqual({ livez: 200, readyz: 200, ready: true });
  });

  it("refuses a call to the marked fragment when the caller presents nothing", async ({
    serve,
    clientWith,
    api,
  }) => {
    // GIVEN the real composition root and a caller with no credentials
    const client = await clientWith(serve(api), undefined);

    // WHEN a procedure of the authenticated fragment is called
    const refused = await client.orders.place({
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 1,
    });

    // THEN it was refused before the use case was reached. `UNAUTHORIZED` is
    // not a code the contract declares, so oRPC does not mark it inferable and
    // the client hands it back on the defect channel — the same treatment a
    // collapsed 500 gets, and the reason a refusal is not something a caller
    // has to match on
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "UNAUTHORIZED", inferable: false }),
    );
  });

  it("refuses the anonymous caller on the wire: a 401 wearing the security headers", async ({
    origin,
  }) => {
    // GIVEN the real composition root served by the `origin` fixture — the
    // raw transport surface, where the facts the typed client hides live

    // WHEN the marked procedure is called with no credential at all
    const response = await request(origin)
      .post("/rpc/orders/place")
      .set("content-type", "application/json")
      .send({ json: { id: "0199a1e0-0000-7000-8000-000000000001", quantity: 1 } });

    // THEN the refusal is a plain 401, and the listener's security headers
    // ride even a refused response
    expect({
      status: response.status,
      nosniff: response.headers["x-content-type-options"],
    }).toEqual({ status: 401, nosniff: "nosniff" });
  });

  it("serves the export to a service token, on the requirement the walk reaches second", async ({
    serve,
    serviceClientFor,
    api,
  }) => {
    // GIVEN the real composition root and a caller holding only an API key
    const client = await serviceClientFor(serve(api));

    // WHEN the export is called — `user` is the requirement declared first, and
    // this caller presents nothing it accepts
    // THEN the walk fell through to the second requirement, and the service
    // arm of the handler is what answered
    await expect(client.orders.export()).toBeOkWith({ csv: "service,reporting" });
  });

  it("serves the export to a user token that carries the scope", async ({
    serve,
    tenant,
    clientWith,
    api,
  }) => {
    // GIVEN a caller whose token grants `orders:export`
    const client = await clientWith(serve(api), `Bearer ${tenant}:u-1:orders:export`);

    // WHEN the export is called
    // THEN the first requirement was satisfied outright — a granted scope is
    // matched against what the endpoint declared, and the user arm answered
    await expect(client.orders.export()).toBeOkWith({ csv: "user,u-1" });
  });

  it("refuses a user token that grants no scope with FORBIDDEN, not UNAUTHORIZED", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN a caller whose token is valid but names no scope
    const client = await clientFor(serve(api));

    // WHEN the export, which asks a user token for `orders:export`, is called
    const refused = await client.orders.export();

    // THEN authenticated-but-under-scoped is a 403: the credential was good, so
    // this is not the 401 an anonymous caller gets, and no scheme in the
    // requirement list rescued it
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "FORBIDDEN", inferable: false }),
    );
  });

  it("refuses a malformed input before the use case is reached", async ({
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN the real composition root and a credentialed caller
    const app = serve(api);
    const client = await clientFor(app);

    // WHEN a procedure is called with an input the contract's schema rejects,
    // past the client's own types
    const refused = await client.orders.place({
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: "abc",
    } as never);

    // THEN oRPC refused it before dispatch. This is the property `type<T>()`
    // did not have: it validates nothing, so `"abc"` reached the use case
    // typed `number`. `BAD_REQUEST` is undeclared, so it lands on the defect
    // channel like any error the contract does not model
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "BAD_REQUEST", inferable: false }),
    );
  });

  it("refuses an id that is not a UUIDv7", async ({ serve, clientFor, api }) => {
    // GIVEN the real composition root and a credentialed caller
    const app = serve(api);
    const client = await clientFor(app);

    // WHEN a procedure is called with an id the contract's schema rejects,
    // past the client's own types
    const refused = await client.orders.place({ id: "o-1", quantity: 2 } as never);

    // THEN oRPC refused it before dispatch, the same schema-level defense a
    // malformed quantity gets, now guarding the id's shape too
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "BAD_REQUEST", inferable: false }),
    );
  });

  it("never enters the handler for a malformed input", async ({ serve, clientFor, recording }) => {
    // GIVEN the real graph, recording every line its logger writes
    const client = await clientFor(serve(recording.api));

    // WHEN a malformed input is sent, past the client's own types
    await client.orders.place({ id: "o-rejected", quantity: "abc" } as never);

    // THEN neither the controller nor the interactor wrote a line: oRPC
    // refused the input before dispatch, so the handler was never entered. The
    // request-scope line still lands, because the unit opened. Asserting on
    // the absence of those two rather than on the stored row, because the
    // DOMAIN would refuse `"abc"` too — a test that checks nothing was stored
    // passes whether or not the contract validates, and pins nothing
    expect(recording.lines().map((line) => line.message)).toEqual(["request finished"]);
  });

  it("serves the unmarked fragment to a caller presenting nothing", async ({
    tenant,
    serve,
    clientWith,
    stubbed,
  }) => {
    // GIVEN the same absent credentials, and a customer registered behind the
    // slice whose fragment carries no marker
    const client = await clientWith(serve(stubbed), undefined);

    // WHEN a procedure of that fragment is called
    // THEN it answers: the marker is per-fragment, so protecting `orders` did
    // not quietly close the rest of the API
    await expect(
      client.customers.find({ tenantId: tenant, id: "0199a1e0-0000-7000-8000-0000000000c1" }),
    ).toBeOkWith({
      id: "0199a1e0-0000-7000-8000-0000000000c1",
      name: "Ada",
    });
  });

  it("serves each caller the tenant its own token names", async ({
    tenant,
    serve,
    clientFor,
    clientWith,
    api,
  }) => {
    // GIVEN two callers on one app, each holding a token for its own tenant
    const app = serve(api);
    const other = `${tenant}-other`;
    const client = await clientFor(app);
    const stranger = await clientWith(app, `Bearer ${other}:u-2`);

    // WHEN the first places an order and the second looks that id up
    const found = await client.orders
      .place({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 })
      .flatMap(() => stranger.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" }));

    // THEN the second sees nothing: the tenant a marked handler serves is
    // `context.principal.tenantId`, and the fragment's inputs name no tenant
    // for a caller to ask for another one with
    expect(found).toBeErrWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "NOT_FOUND",
        data: { id: "0199a1e0-0000-7000-8000-000000000001" },
        inferable: true,
      }),
    );
  });

  it("serves the customers slice alongside the orders slice", async ({
    tenant,
    serve,
    clientFor,
    stubbed,
  }) => {
    // GIVEN an API composed from two slices, each with its own controller, and
    // a customer registered behind the second one
    const client = await clientFor(serve(stubbed));

    // WHEN a procedure from the second slice is called
    // THEN it answers with the contract's shape — the branded `Customer` the
    // use case returned, converted by that controller's own `view`
    await expect(
      client.customers.find({ tenantId: tenant, id: "0199a1e0-0000-7000-8000-0000000000c1" }),
    ).toBeOkWith({
      id: "0199a1e0-0000-7000-8000-0000000000c1",
      name: "Ada",
    });
  });

  it("answers a second read of the same customer without asking the repository again", async ({
    tenant,
    serve,
    clientFor,
    counting,
  }) => {
    // GIVEN a customer read once, so its view is in the cache
    const client = await clientFor(serve(counting.api));
    const input = { tenantId: tenant, id: "0199a1e0-0000-7000-8000-0000000000c1" };
    await client.customers.find(input);

    // WHEN the same customer is read again
    const second = await client.customers.find(input);

    // THEN the answer is the same one, and the repository was asked once —
    // the read-through worked, and the tenant is in the key, so no other
    // test's customer could have answered it
    expect({ second, reads: counting.reads() }).toEqual({
      second: expect.objectContaining({
        value: { id: "0199a1e0-0000-7000-8000-0000000000c1", name: "Ada" },
      }),
      reads: 1,
    });
  });

  it("maps the customers slice's own domain error to its declared NOT_FOUND", async ({
    tenant,
    serve,
    clientFor,
    api,
  }) => {
    // GIVEN the real composition root, whose customers vertical reaches Prisma
    const client = await clientFor(serve(api));

    // WHEN a customer nobody registered is looked up
    const missing = await client.customers.find({
      tenantId: tenant,
      id: "0199a1e0-0000-7000-8000-00000000c404",
    });

    // THEN the domain's `CustomerNotFound` crossed the second slice's own
    // triage the way `OrderNotFound` crosses the first's — a typed, inferable
    // value, not a thrown 500
    expect(missing).toBeErrWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "NOT_FOUND",
        data: { id: "0199a1e0-0000-7000-8000-00000000c404" },
        inferable: true,
      }),
    );
  });

  it("goes unready on drain while staying live", async ({ serve, clientFor, probesFor, gate }) => {
    // GIVEN the runtime and the probe server both bound, with a call in flight
    // so the drain — and the process — stays alive while the probes are read
    const app = serve(gate.api, { probes: { port: 0 } });
    const probes = await probesFor(app);
    const client = await clientFor(app);
    const inFlight = client.orders.find({ id: "0199a1e0-0000-7000-8000-000000000001" });
    await gate.arrived;

    // WHEN the drain starts. The TRANSITION is awaited through `ready()`, which
    // is synchronously readable — polling `/readyz` for it races the app
    // exiting out from under the probe server. The endpoints are then read
    // exactly once, in a state the held call keeps stable.
    app.requestDrain();
    await vi.waitUntil(() => !app.ready());
    const probed = {
      readyz: (await probes.get("/readyz")).status,
      livez: (await probes.get("/livez")).status,
      ready: app.ready(),
    };
    gate.release();
    const served = await inFlight;

    // THEN readiness went false before liveness did, and the held call still
    // ran to completion
    expect({ ...probed, inFlight: served.isOk() }).toEqual({
      readyz: 503,
      livez: 200,
      ready: false,
      inFlight: true,
    });
  });
});
