import { describe, expect, it } from "vitest";

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
});
