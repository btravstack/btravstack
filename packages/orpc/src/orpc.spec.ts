import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("orpc", () => {
  it("serves the router the port provides, with its dependencies injected", async ({ serve }) => {
    // GIVEN an application whose router is a provider over a Greeter
    const { client } = await serve();

    // WHEN a procedure is called over the wire
    const greeting = await client.hello();

    // THEN the router answered with what its injected dependency produced
    expect(greeting).toBe("hello world");
  });

  it("mounts under the prefix it is given", async ({ serve }) => {
    // GIVEN the endpoint mounted somewhere other than /rpc
    const { client } = await serve("/api");

    // WHEN a procedure is called through a link pointed there
    const greeting = await client.hello();

    // THEN it is served — the prefix is the one the handler was mounted on
    expect(greeting).toBe("hello world");
  });

  it("answers an unmatched path with Hono's 404", async ({ serve }) => {
    // GIVEN a path nothing is mounted on
    const { origin } = await serve();

    // WHEN it is requested
    const response = await fetch(`${origin}/nowhere`);

    // THEN Hono's own 404 is the answer, not a hang and not the package's
    expect(response.status).toBe(404);
  });

  it("falls through to Hono when nothing under the prefix matches", async ({ serve }) => {
    // GIVEN a path under the RPC prefix that names no procedure
    const { origin } = await serve();

    // WHEN it is requested
    const response = await fetch(`${origin}/rpc/nope`);

    // THEN oRPC declined and Hono's 404 answered — the two compose rather than
    // the adapter claiming the whole prefix
    expect(response.status).toBe(404);
  });

  it("collapses a defect inside a procedure to oRPC's INTERNAL_SERVER_ERROR", async ({ serve }) => {
    // GIVEN a procedure that throws
    const { client } = await serve();

    // WHEN it is called
    // THEN the client sees oRPC's own collapse, not a reset
    await expect(client.boom()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("leaves the global Request and Response alone", async ({ serve }) => {
    // GIVEN the platform's own Response, captured before any request is served
    const NativeResponse = globalThis.Response;
    const { client } = await serve();

    // WHEN a request has been served through the listener
    await client.hello();

    // THEN nothing was swapped out from under the rest of the process
    expect(globalThis.Response).toBe(NativeResponse);
  });
});
