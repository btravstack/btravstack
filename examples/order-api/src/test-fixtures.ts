import assert from "node:assert/strict";

import { start, type RunningApp } from "@btravstack/core";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { ApplicationModule, Logger, OrderRepository } from "@btravstack/example-order-application";
import { placeOrder, type Order } from "@btravstack/example-order-domain";
import { HttpHandler, httpRuntime, type HttpInfo } from "@btravstack/http";
import { fromSafePromise, OkAsync } from "unthrown";
import { expect, test } from "vitest";

import { createOrderApiClient, type OrderApiClient } from "./client.js";
import { ApiModule } from "./handler.js";
import { OrderApiModule } from "./module.js";
import { RequestModule } from "./request-scope.js";

const anOrder = (id: string, quantity: number): Order => placeOrder(id, quantity).getOrThrow();

const persistenceOf = (repository: ServiceOf<OrderRepository>) =>
  Module("StubPersistence")({
    provides: [Provider(OrderRepository)({ value: repository })],
    exports: [OrderRepository],
  });

/**
 * A composition root shaped like the real one but with the repository swapped:
 * same `ApplicationModule`, same runtime, same two exported ports, so the
 * transport under test is unchanged.
 */
const apiWith = (repository: ServiceOf<OrderRepository>) =>
  Module("StubApi")({
    imports: [ApplicationModule, persistenceOf(repository), ApiModule],
    exports: [HttpHandler, Logger],
  });

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach `Logger` the way `Module.scoped` can. This publishes the very `Logger`
 * service instance the use cases and the request scope write to.
 */
class LoggerTap extends Port("LoggerTap")<{ readonly lines: () => readonly string[] }> {}

const tappedApi = () => {
  let read: () => readonly string[] = () => [];

  return {
    api: Module("TappedApi")({
      imports: [OrderApiModule],
      provides: [
        Provider(LoggerTap)([Logger], {
          sync: (logger) => {
            read = logger.lines;
            return { lines: logger.lines };
          },
        }),
      ],
      exports: [HttpHandler, Logger],
    }),
    traces: (): readonly string[] => read().map((line) => line.slice(0, line.indexOf("]") + 1)),
  };
};

/**
 * A composition root whose repository fails in a way nobody modelled: no
 * `qualify` triaged the rejection, so it is a defect and never reaches the
 * contract's declared error map.
 */
const unmodelledApi = () =>
  apiWith({
    save: (order) => OkAsync(order),
    find: () => fromSafePromise(Promise.reject(new Error("the database is on fire"))),
    remove: () => OkAsync(),
  });

/**
 * A repository whose `find` never settles until `release()` is called, and
 * whose `arrived` promise reports the moment the request reached it. Both drain
 * specs turn on knowing a unit is genuinely in flight before the drain starts —
 * polling a wall clock instead would be the flake.
 */
const gatedApi = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    api: apiWith({
      save: (order) => OkAsync(order),
      find: (id) => {
        entered();
        return fromSafePromise(held.then(() => anOrder(id, 1)));
      },
      remove: () => OkAsync(),
    }),
    arrived,
    release: () => release(),
  };
};

/**
 * `runtimeInfo()` carries `E = never`, so `getOrThrow()` does not even typecheck
 * — the empty error channel is the point. `get()` plus an assertion is the shape
 * the whole fixture module uses.
 */
const portOf = async <E>(app: RunningApp<E, HttpInfo>): Promise<number> => {
  const info = (await app.runtimeInfo()).get();
  assert.ok(info !== undefined, "the runtime published no Serving.info");
  return info.port;
};

export type ApiFixtures = {
  /**
   * Starts an app and registers its shutdown. The teardown runs even when the
   * test fails, which is what the `try`/`finally` blocks used to hand-roll —
   * and it keeps the assertion those blocks carried: the app exited `Ok`.
   *
   * The module's `X` is pinned to the two ports every composition here exports
   * rather than left generic: `start`'s needs gate is a phantom rest parameter
   * proven at the call site, and no proof is available inside a helper generic
   * in the module's own exports. `Logger` is for the gate's OTHER half —
   * `RequestModule`, passed as `StartOptions.unit`, reads it out of the parent.
   */
  readonly serve: <E>(
    module: Module<HttpHandler | Logger, E, Scope>,
    options?: {
      readonly drainTimeoutMs?: number;
      readonly probes?: { readonly port: number } | false;
    },
  ) => RunningApp<E, HttpInfo>;
  readonly clientFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<OrderApiClient>;
  readonly probesFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<string>;
  readonly statusOf: (url: string) => Promise<number>;
  readonly unmodelled: ReturnType<typeof unmodelledApi>;
  readonly gate: ReturnType<typeof gatedApi>;
  readonly tapped: ReturnType<typeof tappedApi>;
};

/**
 * Every spec binds `port: 0` and reads the port back from `Serving.info` — the
 * kernel's own channel for it, which is why this runtime has no `onListening`
 * hook and no `boundPort()` accessor of its own.
 */
const originOf = async <E>(app: RunningApp<E, HttpInfo>): Promise<string> =>
  `http://127.0.0.1:${await portOf(app)}`;

export const it = test.extend<ApiFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: ApiFixtures["serve"] = (module, options) => {
      const app = start(module, {
        runtime: httpRuntime({ port: 0, hostname: "127.0.0.1" }),
        unit: RequestModule,
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        ...options,
      });
      shutdowns.push(async () => {
        app.stop();
        await expect(app.exited).toBeOk();
      });
      return app;
    };

    await use(serve);

    for (const shutdown of shutdowns) await shutdown();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  clientFor: async ({}, use) => {
    await use(async (app) => createOrderApiClient(await originOf(app)));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  probesFor: async ({}, use) => {
    await use(async (app) => {
      const port = (await app.probePort()).get();
      assert.ok(port !== undefined, "the probe server published no port");
      return `http://127.0.0.1:${port}`;
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  statusOf: async ({}, use) => {
    await use(async (url) => (await fetch(url)).status);
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  unmodelled: async ({}, use) => {
    await use(unmodelledApi());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    await use(gatedApi());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  tapped: async ({}, use) => {
    await use(tappedApi());
  },
});
