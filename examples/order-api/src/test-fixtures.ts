import assert from "node:assert/strict";

import type { Env } from "@btravstack/config";
import type { RunningApp, StartOptions } from "@btravstack/core";
import { Module, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { ApplicationModule, Logger, OrderRepository } from "@btravstack/example-order-application";
import { placeOrder, type Order } from "@btravstack/example-order-domain";
import { HttpModule, type HttpInfo, type HttpRuntime } from "@btravstack/http";
import { bootFixture, tapped, type Boot } from "@btravstack/testing";
import { fromSafePromise, OkAsync } from "unthrown";
import { test } from "vitest";

import { createOrderApiClient, type OrderApiClient } from "./client.js";
import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";
import { orderRouter } from "./router.js";

const anOrder = (id: string, quantity: number): Order => placeOrder(id, quantity).getOrThrow();

const persistenceOf = (repository: ServiceOf<OrderRepository>) =>
  Module("StubPersistence")({
    provides: [Provider(OrderRepository)({ value: repository })],
    exports: [OrderRepository],
  });

/**
 * A composition root shaped like the real one but with the repository swapped:
 * same `ApplicationModule`, same `HttpModule` sugar — unpinned, so `serve`'s
 * `env` is what binds it to an ephemeral loopback port — same exports, so
 * the transport under test is unchanged.
 */
const apiWith = (repository: ServiceOf<OrderRepository>) =>
  HttpModule("StubApi")({
    router: orderRouter,
    imports: [ApplicationModule, persistenceOf(repository)],
    exports: [Logger],
  });

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach `Logger` the way `Module.scoped` can. `@btravstack/testing`'s `tapped`
 * hands back the very `Logger` service instance the use cases and the request
 * scope write to, once the graph is built.
 */
const tappedApi = () => {
  const tap = tapped(OrderApi, [Logger]);
  return {
    api: tap.module,
    traces: (): readonly string[] => {
      const [logger] = tap.services();
      return logger.lines().map((line) => line.slice(0, line.indexOf("]") + 1));
    },
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
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * Starts an app on an ephemeral loopback port — `env: { PORT: "0", HOST:
   * "127.0.0.1" }`, which is how every composition here, the real one
   * included, gets bound — with `RequestModule` forked around every request,
   * through `boot`: its shutdown is the fixture's, on every exit path.
   *
   * The module's `X` is pinned to the two ports every composition here
   * exports rather than left generic: `start`'s gate is a phantom rest
   * parameter proven at the call site, and no proof is available inside a
   * helper generic in the module's own exports. `HttpRuntime` is what `start`
   * resolves, and `Logger` is for the gate's OTHER half — `RequestModule`,
   * passed as `StartOptions.unit`, reads it out of the parent.
   */
  readonly serve: <E>(
    module: Module<HttpRuntime | Logger, E, Scope | Env>,
    options?: Pick<StartOptions, "drainTimeoutMs" | "probes">,
  ) => RunningApp<E, HttpInfo>;
  readonly clientFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<OrderApiClient>;
  readonly probesFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<string>;
  readonly statusOf: (url: string) => Promise<number>;
  /** The real composition root. */
  readonly api: typeof OrderApi;
  readonly unmodelled: ReturnType<typeof unmodelledApi>;
  readonly gate: ReturnType<typeof gatedApi>;
  readonly tapped: ReturnType<typeof tappedApi>;
};

/**
 * The port comes back from `Serving.info` — the kernel's own channel for it,
 * which is why this runtime has no `onListening` hook and no `boundPort()`
 * accessor of its own.
 */
const originOf = async <E>(app: RunningApp<E, HttpInfo>): Promise<string> =>
  `http://127.0.0.1:${await portOf(app)}`;

export const it = test.extend<ApiFixtures>({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),

  serve: async ({ boot }, use) => {
    await use((module, options) => boot(module, { unit: RequestModule, ...options }));
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
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
  api: async ({}, use) => {
    await use(OrderApi);
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
