import { describe, expect } from "vitest";

import { DOWNLOAD, it } from "./__tests__/test-fixtures.js";

describe("streaming procedures over RPC", () => {
  it("refuses a route declaring a streamed answer before its handler runs", async ({ bodies }) => {
    // GIVEN a download route declaring `responseBodyHint: "octet-stream"`
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/export", { key: "report" });

    // THEN RPC answered the runtime's 404 and no stream was ever opened
    expect({ status, downloads: bodies.downloads }).toEqual({ status: 404, downloads: [] });
  });

  it("refuses a route that reads its body as a stream", async ({ bodies }) => {
    // GIVEN an upload route declaring `requestBodyHint: "octet-stream"`
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/put", { params: { key: "report" } });

    // THEN RPC answered the runtime's 404
    expect(status).toBe(404);
  });

  it("cancels the stream of an undeclared download and answers a defect", async ({ bodies }) => {
    // GIVEN a download route answering a stream without declaring `responseBodyHint`
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/get", { key: "report" });

    // THEN its stream was cancelled, RPC answered 500, and the defect was reported
    expect({
      status,
      downloads: bodies.downloads,
      defects: bodies.defects.map((defect) => defect.details),
    }).toEqual({
      status: 500,
      downloads: ["opened", "cancelled"],
      defects: [{ "orpc.path": "content.get" }],
    });
  });

  it("answers at once when a stream's cancellation never settles", async ({ bodies }) => {
    // GIVEN an undeclared download whose source never settles its cancellation
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/get", { key: "stuck" });

    // THEN RPC answered 500 without waiting, after starting the cancellation
    expect({ status, downloads: bodies.downloads }).toEqual({
      status: 500,
      downloads: ["opened", "cancelled"],
    });
  });

  it("reports a locked stream it cannot cancel", async ({ bodies }) => {
    // GIVEN an undeclared download answering a stream its handler holds a reader on
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/get", { key: "locked" });

    // THEN RPC answered 500, nothing cancelled it, and the locked stream was its own defect
    expect({
      status,
      downloads: bodies.downloads,
      defects: bodies.defects.map((defect) => defect.details),
    }).toEqual({
      status: 500,
      downloads: ["opened"],
      defects: [
        { "orpc.path": "content.get", "orpc.stream": "locked", "orpc.streams": 1 },
        { "orpc.path": "content.get" },
      ],
    });
  });

  it("cancels a stream answered inside a map", async ({ bodies }) => {
    // GIVEN a procedure answering a Map whose value is a stream
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "content/bundle", { key: "report" });

    // THEN its stream was cancelled and RPC answered 500
    expect({ status, downloads: bodies.downloads }).toEqual({
      status: 500,
      downloads: ["opened", "cancelled"],
    });
  });

  it("keeps serving a procedure that answers no stream", async ({ bodies }) => {
    // GIVEN a JSON procedure beside the streaming ones
    const port = await bodies.serve("buffered");

    // WHEN it is called over RPC
    const status = await bodies.rpc(port, "items/create", { name: "x" });

    // THEN RPC served it
    expect(status).toBe(200);
  });

  it("keeps streaming both downloads over their OpenAPI routes", async ({ bodies }) => {
    // GIVEN the undeclared and the declared download routes
    const port = await bodies.serve("buffered");

    // WHEN a client reads each over OpenAPI
    const report = await bodies.get(port, "/api/content/report");
    const exported = await bodies.get(port, "/api/exports/report");

    // THEN both streamed their bytes, each through the one stream it opened
    expect({
      report: [report.status, report.body],
      exported: [exported.status, exported.body],
      downloads: bodies.downloads,
    }).toEqual({
      report: [200, DOWNLOAD],
      exported: [200, DOWNLOAD],
      downloads: ["opened", "opened"],
    });
  });
});
