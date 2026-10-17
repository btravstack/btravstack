import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("mcp answerer", () => {
  it("answers a tool call with what the caller's principal names", async ({ served }) => {
    // GIVEN the server, and a client holding a key that may call tools
    const client = await (await served()).connect("k-1");

    // WHEN it calls a tool answering a string
    const answered = await client.callTool({ name: "whoami", arguments: {} });

    // THEN the answer is that text, from the principal the key resolved to
    expect(answered).toEqual({ content: [{ type: "text", text: "a-1" }] });
  });

  it("answers a structured value as structured content beside its text", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN it calls a tool answering an object, with validated arguments
    const answered = await client.callTool({ name: "order", arguments: { id: "o-1" } });

    // THEN the model gets both forms the specification asks for
    expect(answered).toEqual({
      content: [{ type: "text", text: '{"id":"o-1","quantity":2}' }],
      structuredContent: { id: "o-1", quantity: 2 },
    });
  });

  it("answers a value that is not an object as its JSON text alone", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN a tool answers an array
    const answered = await client.callTool({ name: "count", arguments: {} });

    // THEN it is text, since structured content must be an object
    expect(answered).toEqual({ content: [{ type: "text", text: "[1,2]" }] });
  });

  it("answers an object whose JSON is not one as text alone", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN a tool answers a Date, which serializes to a string
    const answered = await client.callTool({ name: "epoch", arguments: {} });

    // THEN there is no structured content, which must be an object
    expect(answered).toEqual({ content: [{ type: "text", text: '"1970-01-01T00:00:00.000Z"' }] });
  });

  it("answers undefined, which has no JSON, as its text", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN a tool answers nothing
    const answered = await client.callTool({ name: "nothing", arguments: {} });

    // THEN the text still exists, since a tool's content cannot be empty text
    expect(answered).toEqual({ content: [{ type: "text", text: "undefined" }] });
  });

  it("answers a value JSON cannot encode as a defect, reported", async ({ served }) => {
    // GIVEN the server, recording what its observers are handed
    const server = await served();
    const client = await server.connect("k-1");

    // WHEN a tool answers a bigint
    const answered = await client.callTool({ name: "huge", arguments: {} });

    // THEN the model learns only that it failed, and the cause is reported
    expect({
      answered,
      reported: server.seen.filter(({ operation }) => operation.component === "mcp").length,
    }).toEqual({
      answered: { content: [{ type: "text", text: "The tool failed." }], isError: true },
      reported: 1,
    });
  });

  it("answers a value that cannot even be coerced as a defect", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN a tool answers a value with no JSON whose coercion throws
    const answered = await client.callTool({ name: "hostile", arguments: {} });

    // THEN the model learns only that it failed, not the thrown message
    expect(answered).toEqual({
      content: [{ type: "text", text: "The tool failed." }],
      isError: true,
    });
  });

  it("reads the service this request's unit provides", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN it calls a tool reading the unit
    const answered = await client.callTool({ name: "greet", arguments: {} });

    // THEN the service came from the fork opened for this caller's kind
    expect(answered).toEqual({ content: [{ type: "text", text: "inside unit" }] });
  });

  it("answers a refusal as a tool error the model reads", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN a tool's result is an `Err`
    const answered = await client.callTool({ name: "refuse", arguments: {} });

    // THEN it is a tool error carrying the text the tool's triage wrote
    expect(answered).toEqual({ content: [{ type: "text", text: "not yours" }], isError: true });
  });

  it("answers a defect as a tool error saying nothing of its cause", async ({ served }) => {
    // GIVEN the same client
    const client = await (await served()).connect("k-1");

    // WHEN a tool's result is a defect
    const answered = await client.callTool({ name: "crash", arguments: {} });

    // THEN the model learns only that it failed
    expect(answered).toEqual({
      content: [{ type: "text", text: "The tool failed." }],
      isError: true,
    });
  });

  it("reports a defect to Observers", async ({ served }) => {
    // GIVEN the server, recording what its observers are handed
    const server = await served();
    const client = await server.connect("k-1");

    // WHEN a tool's result is a defect
    await client.callTool({ name: "crash", arguments: {} });

    // THEN the cause the caller never saw is reported
    expect(server.seen.filter(({ operation }) => operation.component === "mcp")).toEqual([
      {
        operation: expect.objectContaining({ component: "mcp", name: "defect" }),
        settled: {
          outcome: "error",
          cause: expect.objectContaining({ message: "the secret cause" }),
        },
      },
    ]);
  });

  it("refuses a caller with no key, challenging it", async ({ served }) => {
    // GIVEN the server, composed with its protected-resource metadata
    const server = await served();

    // WHEN a request carries no credential
    const response = await server.post();

    // THEN it is a bare 401 telling the client where to sign in
    expect(response).toEqual({
      status: 401,
      challenge:
        'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    });
  });

  it("refuses a valid key granted no tool call with 403", async ({ served }) => {
    // GIVEN the server
    const server = await served();

    // WHEN a key that authenticates but lacks the scope is presented
    const response = await server.post("k-2");

    // THEN it is forbidden rather than unauthenticated
    expect(response).toEqual({ status: 403, challenge: null });
  });

  it("challenges a valid Bearer credential missing the MCP mount's scope", async ({ served }) => {
    // GIVEN the same protected resource using a Bearer verifier
    const server = await served({ deployment: "bearer" });
    // WHEN the verified token lacks tools:call
    const response = await server.post("k-2");
    // THEN the actual SDK-facing refusal tells the client what scope is needed
    expect(response).toEqual({
      status: 403,
      challenge:
        'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="tools:call"',
    });
  });

  it("answers a GET with 405 rather than a stream it would hold open", async ({ served }) => {
    // GIVEN the server
    const server = await served();

    // WHEN an authenticated caller opens the standalone stream the SDK would serve
    const response = await server.post("k-1", undefined, "GET");

    // THEN it is refused before any server or unit is built
    expect(response.status).toBe(405);
  });

  it("refuses a body over the deployment's limit", async ({ served }) => {
    // GIVEN a deployment bounding request bodies to 256 bytes
    const server = await served({ bodyLimit: 256 });

    // WHEN an authenticated request carries more
    const response = await server.post("k-1", { padding: "x".repeat(1024) });

    // THEN the SDK refuses it at the runtime's bound
    expect(response.status).toBe(413);
  });

  it("serves a server that requires nothing, under its own mount", async ({ served }) => {
    // GIVEN a deployment with no requirement, mounted at /agents
    const client = await (await served({ deployment: "public" })).connect();

    // WHEN a caller presenting nothing calls a tool
    const answered = await client.callTool({ name: "whoami", arguments: {} });

    // THEN it is served, and its principal is nobody
    expect(answered).toEqual({ content: [{ type: "text", text: "undefined" }] });
  });

  it("takes an unbounded body when the deployment set no limit", async ({ served }) => {
    // GIVEN a deployment whose body limit is 0, the runtime's "unbounded"
    const server = await served({ bodyLimit: 0 });

    // WHEN an authenticated initialize carries more than the SDK's own default would take
    const response = await server.post("k-1", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1.0.0", padding: "x".repeat(5_000_000) },
      },
    });

    // THEN it is answered rather than refused
    expect(response.status).toBe(200);
  });

  it("answers 500 when the scheme itself is a defect", async ({ served }) => {
    // GIVEN a deployment whose authenticator fails rather than refuses
    const server = await served({ deployment: "brokenScheme" });

    // WHEN a request reaches it
    const response = await server.post("k-1");

    // THEN it is the runtime's 500, not a refusal the caller could act on
    expect(response.status).toBe(500);
  });

  it("answers 500 when the request's unit cannot be built", async ({ served }) => {
    // GIVEN a deployment whose unit module fails to construct
    const server = await served({ deployment: "brokenUnit" });

    // WHEN an authenticated request reaches it
    const response = await server.post("k-1");

    // THEN it is the runtime's 500
    expect(response.status).toBe(500);
  });

  it("reports a server that fails to close, once the response is done", async ({ served }) => {
    // GIVEN a deployment whose server rejects its `close`
    const server = await served({ deployment: "unclosable" });

    // WHEN a request is answered and its response closes
    await server.post("k-1");
    await vi.waitUntil(() =>
      server.seen.some(({ operation, settled }) => operation.name === "close" && settled),
    );

    // THEN the failure is reported, not left to reject unhandled
    expect(server.seen.filter(({ operation }) => operation.name === "close")).toEqual([
      {
        operation: expect.objectContaining({ component: "mcp", name: "close" }),
        settled: {
          outcome: "error",
          cause: expect.objectContaining({ message: "close-boom" }),
        },
      },
    ]);
  });

  it("refuses to start when the declared unit differs from the runtime's", async ({
    mismatched,
  }) => {
    // GIVEN an answerer declaring one unit module while the runtime binds another
    // WHEN the application boots
    // THEN the wiring defect is reported
    await expect(mismatched.exited).toBeDefectWith(
      expect.objectContaining({
        message: '[mcp-server] unit kind "anonymous" differs from HttpUnit',
      }),
    );
  });
});
