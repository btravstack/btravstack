import assert from "node:assert/strict";

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
});
