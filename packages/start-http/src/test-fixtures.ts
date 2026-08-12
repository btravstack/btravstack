import type { Server } from "node:http";

import { vi } from "vitest";

/**
 * Capture the real `http.Server` instances the runtime creates, so the
 * error-listener tests can assert on the server itself without exposing it
 * through the shipped `Serving` type just for a test.
 */
export const capturedServers: Server[] = [];
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      capturedServers.push(server);
      return server;
    },
  };
});

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Module, Port, Provider } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start";
import { expect, test } from "vitest";

import { httpRuntime, type HttpHandler, type HttpInfo } from "./http-runtime.js";

/** A port so the runtime's `needs` are non-empty, which is what makes the gate mean something. */
export class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

type App = RunningApp<never, HttpInfo>;

const noop: HttpHandler<typeof Greeting> = (_request, response, _ctx, _signal) =>
  new Promise<void>((done) => response.end("ok", () => done()));

export type HttpFixtures = {
  /**
   * Starts an app on an ephemeral port and registers its shutdown. Teardown runs
   * on every exit path, including a failing assertion, and keeps the assertion a
   * `finally` used to carry: the app exited `Ok`.
   */
  readonly serve: (
    handler?: HttpHandler<typeof Greeting>,
  ) => Promise<{ readonly app: App; readonly origin: string }>;
  /** An app started on an explicit port, for the failure paths. Shut down by the fixture. */
  readonly appOnPort: (port: number) => App;
  readonly occupied: { readonly appOnTakenPort: App };
};

export const it = test.extend<HttpFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const started: App[] = [];

    await use(async (handler = noop) => {
      const app = start(AppModule, {
        runtime: httpRuntime({
          port: 0,
          hostname: "127.0.0.1",
          needs: [Greeting],
          handler,
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);

      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { app, origin: `http://127.0.0.1:${info.port}` };
    });

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeOk();
    }
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  appOnPort: async ({}, use) => {
    const started: App[] = [];

    await use((port) => {
      const app = start(AppModule, {
        runtime: httpRuntime({ port, hostname: "127.0.0.1", needs: [Greeting], handler: noop }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);
      return app;
    });

    for (const app of started) app.stop();
  },

  occupied: async ({ appOnPort }, use) => {
    const blocker = createServer();
    blocker.on("error", () => {});
    const port = await new Promise<number>((done) => {
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        done(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    await use({ appOnTakenPort: appOnPort(port) });

    blocker.close();
  },
});
