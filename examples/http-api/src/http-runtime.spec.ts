import { Module, Port, Provider } from "@btravstack/di";
import { start, type RunningApp, type Runtime } from "@btravstack/start";
import { fromSafePromise } from "unthrown";
import { describe, expect, it } from "vitest";

import { AppModule, Logger, Router, type Handler } from "./app.js";
import { httpRuntime } from "./http-runtime.js";

/**
 * A runtime bound to port 0 knows its address; nothing in `RunningApp` reports
 * it (only the probe server has `probePort()`), so the example's own
 * `onListening` hook is how a caller learns it. Every spec below binds port 0.
 */
const listening = (): {
  readonly runtime: Runtime<typeof Router>;
  readonly port: Promise<number>;
} => {
  let bound!: (port: number) => void;
  const port = new Promise<number>((resolve) => {
    bound = resolve;
  });

  return { runtime: httpRuntime({ port: 0, onListening: (value) => bound(value) }), port };
};

const call = async (
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

  return { status: response.status, body: await response.json() };
};

const text = async (url: string): Promise<{ readonly status: number; readonly body: string }> => {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
};

const shutdown = async <E>(app: RunningApp<E>): Promise<void> => {
  app.stop();
  await app.exited;
};

/**
 * A second application module exporting the same `Router` port, wired to routes
 * the shared one deliberately has no reason to carry: one that throws, one that
 * is slow, one that never settles. `started` records which handlers actually
 * ran, which is how the unknown-route spec proves the application was left
 * alone.
 */
const testRoutes = (): {
  readonly module: ReturnType<typeof routesModule>;
  readonly started: string[];
} => {
  const started: string[] = [];
  return { module: routesModule(started), started };
};

const routesModule = (started: string[]) =>
  Module("TestRoutes")({
    provides: [
      Provider(Router)({
        sync: () => ({
          route: (method, path): Handler | undefined => {
            if (method !== "GET") return undefined;
            if (path === "/ok") {
              return () => {
                started.push("ok");
                return fromSafePromise(Promise.resolve<unknown>({ ok: true }));
              };
            }
            if (path === "/boom") {
              return () => {
                started.push("boom");
                throw new Error("handler exploded");
              };
            }
            if (path === "/slow") {
              return () => {
                started.push("slow");
                return fromSafePromise(
                  new Promise<unknown>((resolve) => setTimeout(() => resolve({ slow: true }), 50)),
                );
              };
            }
            if (path === "/hang") {
              return () => {
                started.push("hang");
                return fromSafePromise(new Promise<unknown>(() => {}));
              };
            }
            return undefined;
          },
        }),
      }),
    ],
    exports: [Router],
  });

/**
 * `start` hands the application context to the runtime alone, narrowed to the
 * runtime's declared needs — so a spec cannot reach `Logger` the way
 * `Module.scoped` can. This module imports the real graph and publishes the
 * very `Logger` service instance the use case writes to.
 */
class LoggerTap extends Port("LoggerTap")<{ readonly lines: () => readonly string[] }> {}

const tappedApp = (): {
  readonly module: ReturnType<typeof tappedModule>;
  readonly lines: () => readonly string[];
} => {
  let read: () => readonly string[] = () => [];
  const module = tappedModule((lines) => {
    read = lines;
  });

  return { module, lines: () => read() };
};

const tappedModule = (publish: (lines: () => readonly string[]) => void) =>
  Module("TappedApp")({
    imports: [AppModule],
    provides: [
      Provider(LoggerTap)([Logger], {
        sync: (logger) => {
          publish(logger.lines);
          return { lines: logger.lines };
        },
      }),
    ],
    exports: [Router],
  });

describe("httpRuntime", () => {
  it("carries a real request through to the DI-wired use case", async () => {
    const { runtime, port } = listening();
    const app = start(AppModule, { runtime, signals: false, probes: false, preDrainDelayMs: 0 });

    try {
      const base = `http://127.0.0.1:${await port}`;

      expect(await call(base, "POST", "/orders", { id: "o-1", quantity: 2 })).toEqual({
        status: 201,
        body: { id: "o-1", quantity: 2 },
      });
    } finally {
      await shutdown(app);
    }
  });

  it("maps each domain error to its own status at the edge", async () => {
    const { runtime, port } = listening();
    const app = start(AppModule, { runtime, signals: false, probes: false, preDrainDelayMs: 0 });

    try {
      const base = `http://127.0.0.1:${await port}`;

      expect((await call(base, "POST", "/orders", { id: "o-1", quantity: 2 })).status).toBe(201);
      expect(await call(base, "POST", "/orders", { id: "o-1", quantity: 2 })).toEqual({
        status: 409,
        body: { error: "DuplicateOrder" },
      });
      expect(await call(base, "GET", "/orders/missing")).toEqual({
        status: 404,
        body: { error: "OrderNotFound" },
      });
    } finally {
      await shutdown(app);
    }
  });

  it("404s an unknown route without running a handler", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
    });

    try {
      const base = `http://127.0.0.1:${await port}`;

      // The runtime's own 404 body, not the domain's `OrderNotFound` one: this
      // request never reached the application.
      expect(await call(base, "GET", "/nowhere")).toEqual({
        status: 404,
        body: { error: "NoRoute" },
      });
      expect(routes.started).toEqual([]);
    } finally {
      await shutdown(app);
    }
  });

  it("maps a defect to a 500 and keeps serving", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
    });

    try {
      const base = `http://127.0.0.1:${await port}`;

      expect(await call(base, "GET", "/boom")).toEqual({
        status: 500,
        body: { error: "InternalError" },
      });
      expect(await call(base, "GET", "/ok")).toEqual({ status: 200, body: { ok: true } });
      expect(app.phase()).toBe("serving");
    } finally {
      await shutdown(app);
    }
  });

  it("runs each request in its own unit", async () => {
    const tapped = tappedApp();
    const { runtime, port } = listening();
    const app = start(tapped.module, {
      runtime,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
    });

    try {
      const base = `http://127.0.0.1:${await port}`;

      expect((await call(base, "POST", "/orders", { id: "o-1", quantity: 1 })).status).toBe(201);
      expect((await call(base, "POST", "/orders", { id: "o-2", quantity: 1 })).status).toBe(201);

      const traces = tapped.lines().map((line) => line.slice(0, line.indexOf("]") + 1));
      expect(traces).toHaveLength(2);
      expect(new Set(traces).size).toBe(2);
    } finally {
      await shutdown(app);
    }
  });

  it("lets an in-flight request finish while draining", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
    });

    const base = `http://127.0.0.1:${await port}`;
    const slow = call(base, "GET", "/slow");
    await expect.poll(() => routes.started.includes("slow")).toBe(true);

    app.requestDrain();

    expect(await slow).toEqual({ status: 200, body: { slow: true } });
    expect(await app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  it("refuses a request that arrives after acceptance has stopped", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
    });

    const base = `http://127.0.0.1:${await port}`;
    // Holds the drain open, so the refusal below is observed while the
    // application is still draining rather than after it has exited.
    const slow = call(base, "GET", "/slow");
    await expect.poll(() => routes.started.includes("slow")).toBe(true);

    app.requestDrain();

    let refusal: unknown;
    await expect
      .poll(async () => {
        try {
          await call(base, "GET", "/ok");
          return false;
        } catch (error) {
          refusal = error;
          return true;
        }
      })
      .toBe(true);

    expect(refusal).toBeInstanceOf(TypeError);
    expect(await slow).toEqual({ status: 200, body: { slow: true } });
    await app.exited;
  });

  it("counts a request still hung at the deadline as abandoned", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: false,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
    });

    const base = `http://127.0.0.1:${await port}`;
    const hung = call(base, "GET", "/hang").then(
      () => "settled" as const,
      () => "failed" as const,
    );
    await expect.poll(() => routes.started.includes("hang")).toBe(true);

    app.requestDrain();

    expect(await app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
    await hung;
  });

  it("answers probes while serving, and goes unready before in-flight work ends", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: { port: 0 },
      preDrainDelayMs: 0,
    });

    const base = `http://127.0.0.1:${await port}`;
    const probes = `http://127.0.0.1:${await app.probePort()}`;

    expect(await text(`${probes}/livez`)).toEqual({ status: 200, body: "ok" });
    expect(await text(`${probes}/readyz`)).toEqual({ status: 200, body: "ready" });

    const slow = call(base, "GET", "/slow");
    await expect.poll(() => routes.started.includes("slow")).toBe(true);

    app.requestDrain();

    await expect.poll(async () => (await text(`${probes}/readyz`)).status).toBe(503);
    expect(await slow).toEqual({ status: 200, body: { slow: true } });
    await app.exited;
  });

  it("binds the probe server to a port of its own", async () => {
    const routes = testRoutes();
    const { runtime, port } = listening();
    const app = start(routes.module, {
      runtime,
      signals: false,
      probes: { port: 0 },
      preDrainDelayMs: 0,
    });

    try {
      const bound = await port;
      const probe = await app.probePort();

      expect(probe).toEqual(expect.any(Number));
      expect(probe).not.toBe(bound);
    } finally {
      await shutdown(app);
    }
  });
});
