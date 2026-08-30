import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("htmx", () => {
  it("serves a GET fragment with its path parameter bound", async ({ htmxServer }) => {
    // GIVEN the htmx answerer serving an unmarked GET route
    const { origin } = await htmxServer();

    // WHEN it is requested with a path parameter
    const response = await fetch(`${origin}/orders/42/row`);

    // THEN it answers 200 with the rendered fragment, the parameter bound
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 200,
      body: '<tr id="row-42">row</tr>',
    });
  });

  it("answers with an HTML content-type", async ({ htmxServer }) => {
    // GIVEN the same GET route
    const { origin } = await htmxServer();

    // WHEN it is requested
    const response = await fetch(`${origin}/orders/42/row`);

    // THEN the content-type is the package's own HTML content-type
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("falls through to the runtime's 404 for a path no route matches", async ({ htmxServer }) => {
    // GIVEN a path inside the mount that no route declares
    const { origin } = await htmxServer();

    // WHEN it is requested
    const response = await fetch(`${origin}/nowhere`);

    // THEN the answerer resolved unwritten and the runtime's own 404 answered
    expect(response.status).toBe(404);
  });

  it("does not reach the GET handler for a POST on the same path", async ({ htmxServer }) => {
    // GIVEN a GET and a POST route declared on the SAME path
    const { origin, rowGetRuns } = await htmxServer();

    // WHEN the path is requested with POST
    const response = await fetch(`${origin}/orders/42/row`, {
      method: "POST",
      body: new URLSearchParams({ note: "hi" }),
    });

    // THEN it answered — matched by method, not by path alone — and the GET
    // handler was never entered
    expect({ status: response.status, ranGet: rowGetRuns() }).toEqual({ status: 200, ranGet: 0 });
  });

  it("answers 401 for a marked route with no credential", async ({ htmxServer }) => {
    // GIVEN a route requiring the "user" scheme
    const { origin } = await htmxServer();

    // WHEN it is requested with no credential
    const response = await fetch(`${origin}/profile`);

    // THEN the caller is refused as unauthenticated
    expect(response.status).toBe(401);
  });

  it("answers 403 for a valid credential missing a declared scope", async ({ htmxServer }) => {
    // GIVEN a route requiring the "admin" scope, and a credential the
    // authenticator grants no scopes at all
    const { origin } = await htmxServer();

    // WHEN it is requested with that credential
    const response = await fetch(`${origin}/admin`, {
      headers: { authorization: "Bearer good" },
    });

    // THEN the caller is refused as under-scoped
    expect(response.status).toBe(403);
  });

  it("answers 413 for a body over the configured limit", async ({ htmxServer }) => {
    // GIVEN the htmx answerer configured with a small body limit
    const { origin } = await htmxServer(8);

    // WHEN a POST body over that limit is sent
    const response = await fetch(`${origin}/orders/42/row`, {
      method: "POST",
      body: new URLSearchParams({ note: "a".repeat(64) }),
    });

    // THEN the body is refused as too large
    expect(response.status).toBe(413);
  });

  it("answers 422 for a body its schema rejects, without calling the handler", async ({
    htmxServer,
  }) => {
    // GIVEN a POST route declaring a schema requiring "note"
    const { origin, rowUpdateRuns } = await htmxServer();

    // WHEN a body missing that field is sent
    const response = await fetch(`${origin}/orders/42/row`, {
      method: "POST",
      body: new URLSearchParams(),
    });

    // THEN validation refused it before the handler ever ran
    expect({ status: response.status, ran: rowUpdateRuns() }).toEqual({ status: 422, ran: 0 });
  });

  it("reaches the handler with the parsed input for a valid POST body", async ({ htmxServer }) => {
    // GIVEN the same POST route, and a body satisfying its schema
    const { origin } = await htmxServer();

    // WHEN it is requested
    const response = await fetch(`${origin}/orders/42/row`, {
      method: "POST",
      body: new URLSearchParams({ note: "updated" }),
    });

    // THEN the handler rendered with the decoded and validated field
    expect(await response.text()).toBe('<tr id="row-42">updated</tr>');
  });

  it("reaches the handler with the resolved principal for a valid credential", async ({
    htmxServer,
  }) => {
    // GIVEN a route requiring the "user" scheme with no scope
    const { origin } = await htmxServer();

    // WHEN it is requested with a credential the authenticator grants
    const response = await fetch(`${origin}/profile`, {
      headers: { authorization: "Bearer good" },
    });

    // THEN the handler read the resolved principal
    expect(await response.text()).toBe("<p>hi u-1</p>");
  });

  it("collapses an authenticator's own defect to the runtime's 500, not a 401", async ({
    htmxServer,
  }) => {
    // GIVEN an authenticator that throws rather than refusing
    const { origin } = await htmxServer();

    // WHEN a route it protects is requested with the credential that trips it
    const response = await fetch(`${origin}/profile`, {
      headers: { authorization: "Bearer boom" },
    });

    // THEN the defect reached the runtime's own fallback rather than the
    // 401/403 mapping — a bug in the authenticator, not a refused caller
    expect(response.status).toBe(500);
  });

  it("hands the decoded form through when the route declares no input schema", async ({
    htmxServer,
  }) => {
    // GIVEN a POST route with no `input` at all
    const { origin } = await htmxServer();

    // WHEN a form body is posted to it
    const response = await fetch(`${origin}/echo`, {
      method: "POST",
      body: new URLSearchParams({ note: "raw" }),
    });

    // THEN the decoded record reached the handler unvalidated, with the
    // handler's own JSON.stringify escaped as ordinary text
    expect(await response.text()).toBe("<p>{&quot;note&quot;:&quot;raw&quot;}</p>");
  });

  it("forwards a genuine request-stream fault rather than modeling it", async ({
    htmxAnswerer,
  }) => {
    // GIVEN the built answerer, and a request whose stream is about to fault
    const answerer = (await htmxAnswerer()).get();
    const request = Object.assign(new EventEmitter(), {
      url: "/echo",
      method: "POST",
      headers: {},
    }) as unknown as IncomingMessage;
    const response = {
      writeHead: () => {
        // oxlint-disable-next-line unthrown/no-throw -- proves the fault is never mistaken for a modeled outcome and answered
        throw new Error("must not write on a stream fault");
      },
      end: () => {
        // oxlint-disable-next-line unthrown/no-throw -- see above
        throw new Error("must not end on a stream fault");
      },
    } as unknown as ServerResponse;

    // WHEN the request stream errors mid-read
    const handled = answerer.handle(request, response, new AbortController().signal);
    request.emit("error", new Error("stream boom"));

    // THEN the fault propagates rather than being swallowed or mapped to a status
    await expect(handled as Promise<unknown>).rejects.toThrow("stream boom");
  });
});
