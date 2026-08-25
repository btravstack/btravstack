import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("http, over a router", () => {
  it("serves the router the port provides, with its dependencies injected", async ({ rpc }) => {
    // GIVEN an application whose router is a provider over a Greeter
    const { client } = await rpc();

    // WHEN a procedure is called over the wire
    const greeting = await client.hello();

    // THEN the router answered with what its injected dependency produced
    expect(greeting).toBe("hello world");
  });

  it("serves a nested procedure the contract declares", async ({ rpc }) => {
    // GIVEN a router implementation shaped like its contract, one level deep
    const { client } = await rpc();

    // WHEN the nested procedure is called
    const pong = await client.nested.ping();

    // THEN the walk found it under its parent and mounted it there
    expect(pong).toBe("pong");
  });

  it("mounts under the prefix it is given", async ({ rpc }) => {
    // GIVEN the endpoint mounted somewhere other than /rpc
    const { client } = await rpc("/api");

    // WHEN a procedure is called through a link pointed there
    const greeting = await client.hello();

    // THEN it is served — the prefix is the one the handler was mounted on
    expect(greeting).toBe("hello world");
  });

  it("drops an implementation key the contract never declared", async ({ rpc }) => {
    // GIVEN a router implementation carrying a key past the types
    const { client } = await rpc(undefined, true);

    // WHEN a declared procedure is called
    const greeting = await client.hello();

    // THEN the router was built — the stray key was skipped, not defected on
    expect(greeting).toBe("hello world");
  });

  it("answers an unmatched path with the runtime's 404", async ({ rpc }) => {
    // GIVEN a path outside the prefix
    const { origin } = await rpc();

    // WHEN it is requested
    const response = await fetch(`${origin}/nowhere`);

    // THEN oRPC declined it unwritten and the runtime's own 404 answered
    expect(response.status).toBe(404);
  });

  it("answers a path under the prefix naming no procedure with the runtime's 404", async ({
    rpc,
  }) => {
    // GIVEN a path under the RPC prefix that names no procedure
    const { origin } = await rpc();

    // WHEN it is requested
    const response = await fetch(`${origin}/rpc/nope`);

    // THEN oRPC declined and the runtime answered — the adapter does not claim
    // the whole prefix
    expect(response.status).toBe(404);
  });

  it("collapses a defect inside a procedure to oRPC's INTERNAL_SERVER_ERROR", async ({ rpc }) => {
    // GIVEN a procedure that throws
    const { client } = await rpc();

    // WHEN it is called
    // THEN the client sees oRPC's own collapse, not a reset
    await expect(client.boom()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("runs a plugin it was handed", async ({ rpcWithCors }) => {
    // GIVEN an app configured with oRPC's CORS plugin
    // WHEN a procedure is called from an origin
    const response = await fetch(`${rpcWithCors.url}/rpc/greet`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.test" },
      body: JSON.stringify({ json: { name: "world" } }),
    });
    // THEN the plugin decided the response's CORS header
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
  });
});
