import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import { Module } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { defineHttp } from "./define-http.js";
import { html } from "./html.js";

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

  it("answers 413 for an over-limit body sent as many chunks, without resetting the connection", async ({
    htmxServer,
  }) => {
    // GIVEN a small body limit, and a body large enough that a single fetch()
    // call cannot deliver it as one TCP chunk — a buffer-then-check
    // implementation and a stream-checking one both pass a small single-chunk
    // body identically, so only a genuinely multi-chunk body distinguishes them
    const { origin } = await htmxServer(8);

    // WHEN several MiB are written across multiple writes over a real socket
    const status = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const request = httpRequest(
        `${origin}/orders/42/row`,
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } },
        (response) => {
          response.resume();
          response.once("end", () => {
            // Destroyed once the answer is in hand, rather than left to drain
            // the rest of a 4 MiB body asynchronously past this test's own
            // return — an in-flight write racing the next test's server
            // startup is exactly the kind of EPIPE this avoids.
            settled = true;
            resolve(response.statusCode ?? 0);
            request.destroy();
          });
        },
      );
      request.on("error", (cause) => {
        if (!settled) reject(cause);
      });
      const chunk = "a".repeat(1024 * 1024);
      for (let i = 0; i < 4; i += 1) request.write(chunk);
      request.end();
    });

    // THEN the oversized body was refused cleanly — a reset connection would
    // have rejected the promise above instead of resolving a status at all
    expect(status).toBe(413);
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

  it("answers no-store on an authenticated fragment response", async ({ htmxServer }) => {
    // GIVEN a route requiring the "user" scheme
    const { origin } = await htmxServer();

    // WHEN it is requested with a credential the authenticator grants
    const response = await fetch(`${origin}/profile`, {
      headers: { authorization: "Bearer good" },
    });

    // THEN a shared cache is told never to store this caller's rendered HTML
    expect(response.headers.get("cache-control")).toBe("no-store");
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

  it("settles rather than hanging when the request is destroyed during authentication", async ({
    htmxAnswerer,
  }) => {
    // GIVEN a MARKED POST route — so `respond` awaits authentication before
    // ever reaching `readBody` — and a request already destroyed by the time
    // that await yields, the exact window a client's abort lands in for real
    const answerer = (await htmxAnswerer()).get();
    const fakeRequest = Object.assign(new EventEmitter(), {
      url: "/secure",
      method: "POST",
      headers: { authorization: "Bearer good" },
      destroyed: false,
    });
    const request = fakeRequest as unknown as IncomingMessage;
    const response = {
      writeHead: () => {
        // oxlint-disable-next-line unthrown/no-throw -- proves nothing is answered once the stream is known gone
        throw new Error("must not write once the request is known destroyed");
      },
      end: () => {
        // oxlint-disable-next-line unthrown/no-throw -- see above
        throw new Error("must not end once the request is known destroyed");
      },
    } as unknown as ServerResponse;

    // WHEN the request is marked destroyed in the SAME tick `handle` is
    // called — before the authenticator's own await ever lets control
    // return to `readBody`
    const handled = answerer.handle(request, response, new AbortController().signal);
    fakeRequest.destroyed = true;

    // THEN `readBody`'s own already-fired guard settles a defect instead of
    // subscribing to a stream that will never emit 'end' — without it this
    // promise never settles and the test times out rather than failing clean
    await expect(handled as Promise<unknown>).rejects.toThrow(
      "the request stream ended before its body was read",
    );
  });

  it("serves each protocol's own path from one runtime on one port", async ({ bothProtocols }) => {
    // GIVEN a root composed with `HttpModule({ router, fragments })`
    const { rpc, fragment } = await bothProtocols();

    // WHEN each protocol's own path is requested
    const answers = { rpc: await rpc(), fragment: await fragment() };

    // THEN both answered, from the one runtime the composition started
    expect(answers).toEqual({ rpc: "pong", fragment: "<p>ok</p>" });
  });

  it("resolves a scheme shared by the router and fragments through one authenticator", async ({
    sharedAuth,
  }) => {
    // GIVEN a router and fragments marked with the SAME scheme through one
    // `defineHttp` registry, so both carry the identical authenticator
    // provider — the shape `HttpModule`'s reference-dedup exists for
    const { rpc, fragment } = await sharedAuth();

    // WHEN each protocol is called with the credential that scheme grants
    const answers = { rpc: await rpc("good"), fragment: await fragment("good") };

    // THEN both resolved the SAME authenticator's principal
    expect(answers).toEqual({ rpc: "u-1", fragment: { status: 200, body: "<p>u-1</p>" } });
  });

  it("threads fragmentsPrefix to htmx() rather than defaulting it", async ({ fragmentsOnly }) => {
    // GIVEN a fragments-only root pinning `fragmentsPrefix: "/ui"`
    const { at } = await fragmentsOnly();

    // WHEN the fragment is requested under the pinned mount, and again at the
    // default `/` no answerer owns
    const answers = { mounted: await at("/ui/status"), atRoot: await at("/status") };

    // THEN it answered only under the pinned mount, not the default — proving
    // the option reached `htmx()` rather than being silently defaulted
    expect(answers).toEqual({
      mounted: { status: 200, body: "<p>ok</p>" },
      atRoot: { status: 404, body: '{"error":"NotFound"}' },
    });
  });

  it("refuses two routes on one method and path as a duplicate provider", async () => {
    // GIVEN two GET routes minted on the same path
    const api = defineHttp();
    const first = api.HtmxGet("/dup")({ inject: {}, sync: () => () => OkAsync(html`a`) });
    const second = api.HtmxGet("/dup")({ inject: {}, sync: () => () => OkAsync(html`b`) });
    const composed = api.HtmxFragments([first, second]);

    // WHEN a graph composes both — each piece registered alongside the
    // composed provider, exactly as any other piece is. `Module.build`
    // directly, not `boot`: the harness's own teardown fails a test on ANY
    // Defect it sees, which is the exact outcome this test asserts.
    const built = await Module.build(Module("Dup")({ provides: [first, second, composed] }));

    // THEN di refuses the build: one port id, two providers
    expect(built).toBeDefectWith(
      expect.objectContaining({ message: expect.stringContaining("two providers") }),
    );
  });
});
