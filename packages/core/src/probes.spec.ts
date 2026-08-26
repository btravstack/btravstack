import assert from "node:assert/strict";
import type { Server } from "node:http";

import { OkAsync, type AsyncResult } from "unthrown";
import { describe, expect, it, vi } from "vitest";

// Capture the real `http.Server` instances `startProbeServer` creates, so the
// two error-listener tests can assert on the server itself. Its listener set is
// the observable most directly tied to both halves of that contract — a stale
// `once("error", ...)` swallowing a post-bind failure, and zero listeners
// turning one into an unhandled throw — without exposing the raw server through
// the shipped `ProbeServer` type just for a test. `vi.mock` is hoisted above the
// imports below by vitest's transform.
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

import type { HealthReport } from "./health.js";
import { startProbeServer } from "./probes.js";

/** The last captured `http.Server`, asserted here so a test body cannot pass on an empty capture. */
const lastCreatedServer = (): Server => {
  const server = createdServers.at(-1);
  assert.ok(server !== undefined, "the node:http mock did not intercept createServer");
  return server;
};

const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
};

const healthy = (): AsyncResult<HealthReport, never> =>
  OkAsync({ status: "healthy" as const, components: [] });

describe("startProbeServer", () => {
  it("serves the health report, and 503 when a component is down", async () => {
    // GIVEN a probe server whose health function reports one component down
    const report = {
      status: "unhealthy" as const,
      components: [
        { name: "cache", status: "healthy" as const },
        { name: "database", status: "unhealthy" as const, reason: "connection refused" },
      ],
    };
    const started = await startProbeServer({
      port: 0,
      live: () => true,
      ready: () => true,
      health: () => OkAsync(report),
    });
    const server = started.getOrThrow();

    // WHEN /healthz is asked
    const response = await get(server.port, "/healthz");

    // THEN the status is 503 and the body names WHICH component is down
    expect({ status: response.status, body: JSON.parse(response.body) }).toEqual({
      status: 503,
      body: report,
    });
    await server.close();
  });

  it("serves liveness and readiness from the supplied predicates", async () => {
    let ready = false;
    const started = await startProbeServer({
      port: 0,
      live: () => true,
      health: healthy,
      ready: () => ready,
    });
    const server = started.getOrThrow();

    expect(await get(server.port, "/livez")).toEqual({ status: 200, body: "ok" });
    expect((await get(server.port, "/readyz")).status).toBe(503);

    ready = true;
    expect(await get(server.port, "/readyz")).toEqual({ status: 200, body: "ready" });

    await server.close();
  });

  it("404s an unknown path", async () => {
    const started = await startProbeServer({
      port: 0,
      live: () => true,
      health: healthy,
      ready: () => true,
    });
    const server = started.getOrThrow();

    expect((await get(server.port, "/nope")).status).toBe(404);

    await server.close();
  });

  it("reports a port it cannot bind", async () => {
    const first = (
      await startProbeServer({ port: 0, live: () => true, health: healthy, ready: () => true })
    ).getOrThrow();

    const second = await startProbeServer({
      port: first.port,
      live: () => true,
      health: healthy,
      ready: () => true,
    });

    expect(second).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "probes" }),
    );
    await first.close();
  });

  it("reports an out-of-range port as a modeled failure, not a defect", async () => {
    // GIVEN a port node rejects synchronously — `server.listen` validates the
    // range itself and THROWS `ERR_SOCKET_BAD_PORT` rather than emitting
    // `'error'`, so the throw escapes the executor and rejects the promise.
    // `PROBE_PORT=70000` reaching this is the motivating case.

    // WHEN the probe server is asked to bind it
    const started = await startProbeServer({
      port: 70_000,
      live: () => true,
      health: healthy,
      ready: () => true,
    });

    // THEN it arrives in the declared error channel. A defect here would bypass
    // `AsyncResult<ProbeServer, RuntimeStartFailed>` entirely and exit 70 where
    // a modeled startup failure exits 1.
    expect(started).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "probes" }),
    );
  });

  it("swaps the bind-failure error listener for one that outlives the bind", async () => {
    // GIVEN a probe server that bound successfully
    const before = createdServers.length;
    const started = await startProbeServer({
      port: 0,
      live: () => true,
      health: healthy,
      ready: () => true,
    });
    const server = started.getOrThrow();

    // WHEN its listener set is inspected
    const created = createdServers[createdServers.length - 1];

    // THEN `onBindError` is gone — it could only resolve an already-settled
    // deferred — but the server is not left with ZERO listeners, which would
    // make any later `'error'` an unhandled EventEmitter throw.
    expect({
      created: createdServers.length - before,
      listeners: created?.listenerCount("error"),
    }).toEqual({ created: 1, listeners: 1 });

    await server.close();
  });

  it("does not throw when the server emits an error after binding", async () => {
    // GIVEN a bound probe server — `net.Server` still emits `'error'` after
    // listening, on accept failures such as `EMFILE` under fd exhaustion.
    const started = await startProbeServer({
      port: 0,
      live: () => true,
      health: healthy,
      ready: () => true,
    });
    const server = started.getOrThrow();

    // WHEN one is emitted, and THEN it is absorbed. Unhandled, it would reach
    // the kernel's `uncaughtException` handler and tear the whole application
    // down over a transient fault in its health endpoint.
    expect(() => lastCreatedServer().emit("error", new Error("accept"))).not.toThrow();

    await server.close();
  });
});
