import { ORPCError } from "@orpc/client";
import request from "supertest";
import { Ok } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

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

    // WHEN a second request — a second unit, the same database — looks up what
    // the first wrote
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
    // `inferable` is what makes it one rather than a `Defect` collapsed to
    // INTERNAL_SERVER_ERROR.
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

    // WHEN the channel is folded — the mirror of the `mapErrCases` that produced
    // it, with no wildcard to fall back on
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

    // THEN the raw cause does NOT leak over the wire; oRPC collapses it, and the
    // non-inferable result lands back in the defect channel
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

    // WHEN a call blows up and another one follows it — the defect is consumed
    // rather than asserted, since the test above is its subject
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

    // THEN two calls, each writing three lines, carrying two distinct trace ids
    // and never one written outside a unit
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
    // `vi.waitUntil` synchronises rather than asserts.
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

    // THEN the drain report says the unit finished — read through the in-flight
    // call, so its own `Result` is consumed
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
    // call settles only after the report, so the `flatTap` consumes it in that
    // order; it is asserted on its own in the test below.
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

    // THEN `stop` destroyed the socket under it, so the client's own `Result` is
    // a defect carrying the fetch stack's transport error
    await expect(hung).toBeDefectWith(expect.any(Error));
  });

  it("answers both probes while the runtime serves", async ({ serve, probesFor, gate }) => {
    // GIVEN the runtime and the kernel's probe server both bound
    const app = serve(gate.api, { probes: { port: 0 } });
    const probes = await probesFor(app);
    // The probe server binds BEFORE the graph is built and answers 503 until the
    // runtime is serving, so `runtimeInfo()` is the barrier.
    await app.runtimeInfo();

    // WHEN both endpoints are read while serving
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

    // THEN it was refused before the use case was reached. The contract declares
    // no `UNAUTHORIZED`, so it is not inferable and lands on the defect channel.
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "UNAUTHORIZED", inferable: false }),
    );
  });

  it("refuses the anonymous caller on the wire: a 401 wearing the security headers", async ({
    origin,
  }) => {
    // GIVEN the real composition root on the raw transport surface, where the
    // facts the typed client hides live

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

    // WHEN the export is called — `user` is declared first, and this caller
    // presents nothing it accepts
    // THEN the walk fell through to the second requirement, and the service arm
    // answered
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

    // THEN authenticated-but-under-scoped is a 403, not the 401 an anonymous
    // caller gets
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "FORBIDDEN", inferable: false }),
    );
  });

  it("carries a page and the cursor that continues it over the wire", async ({
    serve,
    clientFor,
    stubbed,
  }) => {
    // GIVEN a root whose repository holds more orders than one page
    const client = await clientFor(serve(stubbed));

    // WHEN the first page is asked for, and then the page after its cursor —
    // chained, so a failed first page cannot be read as a short second one
    const second = await client.orders.list({ limit: 1 }).flatMap((page) =>
      client.orders.list({
        limit: 1,
        ...(page.hasNextPage ? { after: page.nextCursor } : {}),
      }),
    );

    // THEN the cursor made the round trip opaque: the client passed back a
    // string it never read, and the listing closed with no cursor at all —
    // `nextCursor` is absent on the wire, not null
    expect(second).toBeOkWith({
      items: [{ id: "0199a1e0-0000-7000-8000-00000000000b", quantity: 2 }],
      previousCursor: "page-2-start",
      hasPreviousPage: true,
      hasNextPage: false,
    });
  });

  it("leaves the closed side's cursor off the wire entirely, rather than sending a null", async ({
    tenant,
    serve,
    originFor,
    stubbed,
  }) => {
    // GIVEN the stub root on the raw transport surface, where the typed client's
    // shape is not what decides the payload
    const origin = await originFor(serve(stubbed));

    // WHEN the last page is read as raw JSON
    const response = await request(origin)
      .post("/rpc/orders/list")
      .set("authorization", `Bearer ${tenant}:u-1`)
      .set("content-type", "application/json")
      .send({ json: { limit: 1, after: "page-1-end" } });

    // THEN `hasNextPage: false` arrives with no `nextCursor` KEY at all — the
    // arm of the output schema that carries the cursor is the one that claims
    // the page, so a null nobody may follow cannot be sent. `toStrictEqual`
    // rather than `toEqual`: the absence IS the assertion here, and `toEqual`
    // reads an `undefined` property as an absent one
    expect(response.body.json).toStrictEqual({
      items: [{ id: "0199a1e0-0000-7000-8000-00000000000b", quantity: 2 }],
      previousCursor: "page-2-start",
      hasPreviousPage: true,
      hasNextPage: false,
    });
  });

  it("pages backward over the wire, following previousCursor", async ({
    serve,
    clientFor,
    stubbed,
  }) => {
    // GIVEN the second page, reached by following `nextCursor`
    const client = await clientFor(serve(stubbed));

    // WHEN the page before it is asked for
    const back = await client.orders
      .list({ limit: 1 })
      .flatMap((page) =>
        client.orders.list({
          limit: 1,
          ...(page.hasNextPage ? { after: page.nextCursor } : {}),
        }),
      )
      .flatMap((page) =>
        client.orders.list({
          limit: 1,
          ...(page.hasPreviousPage ? { before: page.previousCursor } : {}),
        }),
      );

    // THEN the first page comes back. `before` and `after` are the same kind of
    // opaque string in the same schema, and the port'"'"'s own type is what says
    // only one of them may be set
    expect(back).toBeOkWith({
      items: [{ id: "0199a1e0-0000-7000-8000-00000000000a", quantity: 1 }],
      hasPreviousPage: false,
      nextCursor: "page-1-end",
      hasNextPage: true,
    });
  });

  it("refuses a page asked for in both directions at once", async ({
    serve,
    clientFor,
    stubbed,
  }) => {
    // GIVEN the same root
    const client = await clientFor(serve(stubbed));

    // WHEN a caller asks for a page after one cursor and before another
    const refused = await client.orders.list({
      limit: 1,
      after: "page-1-end",
      before: "page-2-start",
    } as never);

    // THEN the CONTRACT refuses it before dispatch — a page runs in one
    // direction, and "after X and before Y" is a range query wearing a page'"'"'s
    // clothes. The handler never runs, so this is the non-inferable 400 oRPC
    // mints rather than the one the controller returns
    expect(refused).toBeDefectWith(
      expect.objectContaining({ constructor: ORPCError, code: "BAD_REQUEST", inferable: false }),
    );
  });

  it("turns an unreadable cursor into a typed, inferable BAD_REQUEST", async ({
    serve,
    clientFor,
    stubbed,
  }) => {
    // GIVEN the same root
    const client = await clientFor(serve(stubbed));

    // WHEN a page is asked for after a cursor the caller made up
    const refused = await client.orders.list({ limit: 1, after: "not-a-cursor" });

    // THEN it arrives on the error channel carrying the offending string — a
    // value the client can match on, not a 500: the cursor is input
    expect(refused).toBeErrWith(
      expect.objectContaining({
        constructor: ORPCError,
        code: "BAD_REQUEST",
        inferable: true,
        data: { cursor: "not-a-cursor" },
      }),
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

    // THEN oRPC refused it before dispatch — the property `type<T>()` did not
    // have, under which `"abc"` reached the use case typed `number`
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

    // THEN neither the controller nor the interactor wrote a line, and the
    // request-scope one still lands because the unit opened. Asserted on those
    // two absences rather than on the stored row, because the DOMAIN would
    // refuse `"abc"` too and such a test would pin nothing.
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

    // THEN the second sees nothing: a marked handler serves the tenant on its
    // principal, and the fragment's inputs name none for a caller to ask with
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
    // THEN it answers with the contract's shape, converted by that controller's
    // own `view`
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

    // THEN the answer is the same one and the repository was asked once — the
    // read-through worked, with the tenant in the key
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

    // THEN the domain's `CustomerNotFound` crossed the second slice's own triage
    // as a typed, inferable value rather than a thrown 500
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

    // WHEN the drain starts. The transition is awaited through `ready()`, which
    // is synchronously readable — polling `/readyz` for it races the app exiting
    // out from under the probe server.
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
