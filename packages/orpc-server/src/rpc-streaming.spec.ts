import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("streaming procedures over RPC", () => {
  it("refuses a download before its handler opens a stream", async ({ bodies }) => {
    // GIVEN a detailed GET route whose body schema is a stream
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/get", { key: "report" });

    // THEN RPC answered the runtime's 404 and no stream was ever opened
    expect({ status, downloads: bodies.downloads }).toEqual({ status: 404, downloads: [] });
  });

  it("refuses a route that reads its body as a stream", async ({ bodies }) => {
    // GIVEN a PUT route declaring `requestBodyHint: "octet-stream"`
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/put", { params: { key: "report" } });

    // THEN RPC answered the runtime's 404
    expect(status).toBe(404);
  });

  it("refuses a route declaring a streamed answer its schema cannot show", async ({ bodies }) => {
    // GIVEN a route declaring `responseBodyHint: "octet-stream"` over an unchecked body
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/export", { key: "report" });

    // THEN RPC answered the runtime's 404 and no stream was ever opened
    expect({ status, downloads: bodies.downloads }).toEqual({ status: 404, downloads: [] });
  });

  it("refuses a download whose schema refuses a plain body at its root", async ({ bodies }) => {
    // GIVEN a detailed route whose object-level check alone requires a streamed body
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "items/sized", undefined);

    // THEN RPC answered the runtime's 404 and no stream was ever opened
    expect({ status, downloads: bodies.downloads }).toEqual({ status: 404, downloads: [] });
  });

  it("keeps serving every procedure that streams nothing", async ({ bodies }) => {
    // GIVEN a plain procedure, one whose output schema throws on the probe,
    // one whose output validates asynchronously and rejects the probe, and a
    // detailed answer whose JSON body would also accept a stream
    const port = await bodies.serve("buffered");

    // WHEN each is called over RPC
    const statuses = {
      create: await bodies.rpc(port, "items/create", { name: "x" }),
      strict: await bodies.rpc(port, "items/strict", { name: "x" }),
      checked: await bodies.rpc(port, "items/checked", { name: "x" }),
      counted: await bodies.rpc(port, "items/counted", undefined),
    };

    // THEN RPC served them all
    expect(statuses).toEqual({ create: 200, strict: 200, checked: 200, counted: 200 });
  });

  it("keeps serving the download over its OpenAPI route", async ({ bodies }) => {
    // GIVEN the same download route
    const port = await bodies.serve("buffered");

    // WHEN a client reads it over OpenAPI
    const answer = await bodies.get(port, "/api/content/report");

    // THEN it streamed, through the one stream it opened
    expect({ status: answer.status, downloads: bodies.downloads }).toEqual({
      status: 200,
      downloads: ["opened"],
    });
  });
});
