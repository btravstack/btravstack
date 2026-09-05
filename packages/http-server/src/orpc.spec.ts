import { CORSHandlerPlugin } from "@orpc/server/plugins";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

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

  it("runs a plugin it was handed", async ({ rpcPolicy }) => {
    // GIVEN an app handed oRPC's CORS plugin through the escape hatch
    const { greet } = await rpcPolicy({
      plugins: [new CORSHandlerPlugin({ origin: () => "https://example.test" })],
    });

    // WHEN a procedure is called from an origin
    const response = await greet("world", { origin: "https://example.test" });

    // THEN the plugin decided the response's CORS header
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
  });

  it("reflects the request's origin when cors is enabled", async ({ rpcPolicy }) => {
    // GIVEN an app configured with `cors: true` rather than a plugin
    const { greet } = await rpcPolicy({ cors: true });

    // WHEN a procedure is called from an origin
    const response = await greet("world", { origin: "https://example.test" });

    // THEN oRPC's own default decided the header
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
  });

  it("takes the cors options it was given", async ({ rpcPolicy }) => {
    // GIVEN an app configured with a CORS record
    const { greet } = await rpcPolicy({ cors: { origin: "https://allowed.test" } });

    // WHEN a procedure is called from that origin
    const response = await greet("world", { origin: "https://allowed.test" });

    // THEN the configured origin is what the header carries
    expect(response.headers.get("access-control-allow-origin")).toBe("https://allowed.test");
  });

  it("rejects a body over the default limit", async ({ rpcPolicy }) => {
    // GIVEN an app that configured no body limit at all
    const { greet } = await rpcPolicy({});

    // WHEN a procedure is called with a body over 1 MiB
    const response = await greet("x".repeat(1_100_000));

    // THEN oRPC answered PAYLOAD_TOO_LARGE
    expect(response.status).toBe(413);
  });

  it("rejects a body over the limit it was given", async ({ rpcPolicy }) => {
    // GIVEN an app with a tiny body limit
    const { greet } = await rpcPolicy({ bodyLimit: 16 });

    // WHEN a procedure is called with a body over it
    const response = await greet("world");

    // THEN oRPC answered PAYLOAD_TOO_LARGE
    expect(response.status).toBe(413);
  });

  it("reads an unbounded body when the limit is off", async ({ rpcPolicy }) => {
    // GIVEN an app that turned the limit off
    const { greet } = await rpcPolicy({ bodyLimit: false });

    // WHEN a procedure is called with a body over the default limit
    const response = await greet("x".repeat(1_100_000));

    // THEN it was served
    expect(response.status).toBe(200);
  });

  it("compresses a response when compression is enabled", async ({ rpcPolicy }) => {
    // GIVEN an app configured with `compression: true`
    const { encodingOf } = await rpcPolicy({ compression: true });

    // WHEN a procedure answers with more than the default 1 KB threshold
    const encoding = await encodingOf("x".repeat(2048));

    // THEN the response came back gzipped
    expect(encoding).toBe("gzip");
  });

  it("reads the body limit and the CORS origin from the environment", async ({ rpcPolicy }) => {
    // GIVEN an app that configures no policy at all, deployed with one
    const { greet } = await rpcPolicy(
      {},
      { HTTP_BODY_LIMIT: "4096", HTTP_CORS_ORIGIN: "https://allowed.test" },
    );

    // WHEN a body over the deployed limit is sent from the deployed origin
    const response = await greet("x".repeat(8192), { origin: "https://allowed.test" });

    // THEN both variables were honoured — HTTP_CORS_ORIGIN alone turns CORS on,
    // with no `cors` option anywhere
    expect({
      status: response.status,
      origin: response.headers.get("access-control-allow-origin"),
    }).toEqual({ status: 413, origin: "https://allowed.test" });
  });

  it("reads compression from the environment", async ({ rpcPolicy }) => {
    // GIVEN an app that configures no policy at all, deployed with compression on
    const { encodingOf } = await rpcPolicy({}, { HTTP_COMPRESSION: "true" });

    // WHEN a procedure answers with more than the default threshold
    const encoding = await encodingOf("x".repeat(2048));

    // THEN the response came back gzipped
    expect(encoding).toBe("gzip");
  });

  it("prefers the option over the environment, per field", async ({ rpcPolicy }) => {
    // GIVEN an app whose body limit is pinned against an environment saying otherwise
    const { greet } = await rpcPolicy({ bodyLimit: false }, { HTTP_BODY_LIMIT: "16" });

    // WHEN a body over the deployed limit is sent
    const response = await greet("x".repeat(64));

    // THEN the pin won — explicit beats environment beats default
    expect(response.status).toBe(200);
  });

  it("takes the compression options it was given", async ({ rpcPolicy }) => {
    // GIVEN an app configured with a compression record naming deflate alone
    const { encodingOf } = await rpcPolicy({ compression: { encodings: ["deflate"] } });

    // WHEN a procedure answers with more than the default threshold
    const encoding = await encodingOf("x".repeat(2048));

    // THEN the configured scheme is what the response used
    expect(encoding).toBe("deflate");
  });

  it("answers 500 when the bound anonymous unit module fails to build", async ({
    brokenScoped,
  }) => {
    // GIVEN an app whose anonymous unit module's provider throws on build
    const { origin } = await brokenScoped();

    // WHEN a procedure is called
    const response = await fetch(`${origin}/rpc/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // THEN the fork's defect reaches the caller as the runtime's own 500,
    // never a hung request
    expect(response.status).toBe(500);
  });
});

describe("unit kinds", () => {
  it("forks the user module, seeded with the principal, for a marked leaf", async ({
    kindedRpc,
  }) => {
    // GIVEN a router binding both kinds
    const { clientWith, counts, seen } = await kindedRpc.serve(["anonymous", "user"]);

    // WHEN a MARKED procedure is called with a credential the scheme accepts
    await clientWith("good").orders.whoami({ id: "o-1" });
    await vi.waitUntil(() => counts().user.stops === 1);

    // THEN only the user kind was opened, seeded with what its scheme resolved
    expect({ user: counts().user, anonymous: counts().anonymous, seen: seen() }).toEqual({
      user: { builds: 1, stops: 1 },
      anonymous: { builds: 0, stops: 0 },
      seen: [{ tenantId: "t-good", userId: "u-good" }],
    });
  });

  it("forks anonymous, with no seed, for an unmarked leaf", async ({ kindedRpc }) => {
    // GIVEN the same router binding both kinds
    const { clientWith, counts, seen } = await kindedRpc.serve(["anonymous", "user"]);

    // WHEN an UNMARKED procedure is called, credential or not
    await clientWith("good").health.ping();
    await vi.waitUntil(() => counts().anonymous.stops === 1);

    // THEN the anonymous kind was opened and nothing was seeded
    expect({ anonymous: counts().anonymous, user: counts().user, seen: seen() }).toEqual({
      anonymous: { builds: 1, stops: 1 },
      user: { builds: 0, stops: 0 },
      seen: [],
    });
  });

  it("falls back to anonymous when the scheme binds no module", async ({ kindedRpc }) => {
    // GIVEN a router binding `anonymous` alone — what an application that never
    // specialised a kind has
    const { clientWith, counts } = await kindedRpc.serve(["anonymous"]);

    // WHEN a MARKED procedure resolves the `user` scheme, which binds nothing
    await clientWith("good").orders.whoami({ id: "o-1" });
    await vi.waitUntil(() => counts().anonymous.stops === 1);

    // THEN the anonymous module was forked all the same, so binding it alone
    // keeps forking on every leaf
    expect(counts()).toEqual({
      anonymous: { builds: 1, stops: 1 },
      user: { builds: 0, stops: 0 },
    });
  });

  it("forks nothing when neither the scheme nor anonymous is bound", async ({ kindedRpc }) => {
    // GIVEN a router binding no kind at all
    const { clientWith, counts } = await kindedRpc.serve([]);

    // WHEN a marked procedure is called
    const answer = await clientWith("good").orders.whoami({ id: "o-1" });

    // THEN nothing was forked, and the request was still answered
    expect({ answer, counts: counts() }).toEqual({
      answer: { userId: "u-good" },
      counts: { anonymous: { builds: 0, stops: 0 }, user: { builds: 0, stops: 0 } },
    });
  });
});
