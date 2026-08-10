import type { Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

// Capture the real `http.Server` instances `startProbeServer` creates, so the
// "listener is removed after a successful bind" test can assert on the server
// itself. This is the observable most directly tied to the fix (a stale
// `once("error", ...)` listener swallowing a post-bind failure) without
// exposing the raw server through the shipped `ProbeServer` type just for a
// test. `vi.mock` is hoisted above the imports below by vitest's transform.
const createdServers: Server[] = [];
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      createdServers.push(server);
      return server;
    },
  };
});

import { startProbeServer } from "./probes.js";

const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
};

describe("startProbeServer", () => {
  it("serves liveness and readiness from the supplied predicates", async () => {
    let ready = false;
    const started = await startProbeServer({ port: 0, live: () => true, ready: () => ready });
    const server = started.getOrThrow();

    expect(await get(server.port, "/livez")).toEqual({ status: 200, body: "ok" });
    expect((await get(server.port, "/readyz")).status).toBe(503);

    ready = true;
    expect(await get(server.port, "/readyz")).toEqual({ status: 200, body: "ready" });

    await server.close();
  });

  it("404s an unknown path", async () => {
    const started = await startProbeServer({ port: 0, live: () => true, ready: () => true });
    const server = started.getOrThrow();

    expect((await get(server.port, "/nope")).status).toBe(404);

    await server.close();
  });

  it("reports a port it cannot bind", async () => {
    const first = (
      await startProbeServer({ port: 0, live: () => true, ready: () => true })
    ).getOrThrow();

    const second = await startProbeServer({
      port: first.port,
      live: () => true,
      ready: () => true,
    });

    expect(second).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "probes" }),
    );
    await first.close();
  });

  it("removes the bind-failure error listener once the bind succeeds", async () => {
    const before = createdServers.length;
    const started = await startProbeServer({ port: 0, live: () => true, ready: () => true });
    const server = started.getOrThrow();

    const created = createdServers[createdServers.length - 1];
    expect(createdServers.length).toBe(before + 1);
    expect(created?.listenerCount("error")).toBe(0);

    await server.close();
  });
});
