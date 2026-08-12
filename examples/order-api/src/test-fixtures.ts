import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type Socket } from "node:net";

import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  OrderRepository,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { placeOrder, type Order } from "@btravstack/start-example-order-domain";
import { fromSafePromise, OkAsync } from "unthrown";
import { expect, test, vi } from "vitest";

import { createOrderApiClient, type OrderApiClient } from "./client.js";
import { OrderApiModule } from "./module.js";
import { orpcRuntime, type OrderApiInfo } from "./orpc-runtime.js";

type App<E> = RunningApp<E, OrderApiInfo>;

/**
 * `X` is pinned to the three ports the runtime declares rather than left
 * generic: `start`'s needs gate is a phantom rest parameter proven at the call
 * site, and no proof is available inside a helper generic in the module's own
 * exports.
 */
type ApiPorts = PlaceOrder | FindOrder | Logger;

type ServeOptions = {
  readonly drainTimeoutMs?: number;
  readonly probes?: { readonly port: number } | false;
};

type Serve = <E>(module: Module<ApiPorts, E, Scope>, options?: ServeOptions) => App<E>;

const anOrder = (id: string, quantity: number): Order => placeOrder(id, quantity).getOrThrow();

const persistenceOf = (repository: ServiceOf<OrderRepository>) =>
  Module("StubPersistence")({
    provides: [Provider(OrderRepository)({ value: repository })],
    exports: [OrderRepository],
  });

/**
 * A composition root shaped like the real one but with the repository swapped:
 * same `ApplicationModule`, same runtime, same three exported ports, so the
 * transport under test is unchanged.
 */
const apiWith = (repository: ServiceOf<OrderRepository>) =>
  Module("StubApi")({
    imports: [ApplicationModule, persistenceOf(repository)],
    provides: [],
    exports: [PlaceOrder, FindOrder, Logger],
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
      exports: [PlaceOrder, FindOrder, Logger],
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
const portOf = async <E>(app: App<E>): Promise<number> => {
  const info = (await app.runtimeInfo()).get();
  assert.ok(info !== undefined, "the runtime published no Serving.info");
  return info.port;
};

/**
 * A raw keep-alive connection, so a spec can hold one **busy** across a drain.
 *
 * `fetch` cannot express either half: undici owns its connection pool, and
 * `Connection` is hop-by-hop so it never reaches the `Response` — nor will
 * `fetch` send a header with an empty value, which one spec here is entirely
 * about. And busy is the point: `server.closeIdleConnections()` reaches every
 * *idle* connection and no others, so a busy one is the only population that
 * can still be served after the drain.
 */
const keepAliveOf = () => {
  const opened: Socket[] = [];

  return {
    /**
     * Sends one `orders.find` call down a fresh keep-alive connection and hands
     * back its response head. Pair it with `gate` so the spec knows the call has
     * genuinely reached the repository — and the connection is therefore busy —
     * before the drain starts.
     */
    call: async <E>(app: App<E>, headers: Readonly<Record<string, string>> = {}) => {
      const socket = connect(await portOf(app), "127.0.0.1");
      // A raw socket with no `'error'` listener throws on reset, and a drain
      // resets it by design.
      socket.on("error", () => {});
      opened.push(socket);
      await once(socket, "connect");

      let received = "";
      const head = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
          const end = received.indexOf("\r\n\r\n");
          if (end !== -1) resolve(received.slice(0, end));
        });
      });

      const body = '{"json":{"id":"o-1"}}';
      // Written raw because `fetch` will not send a header with an empty value,
      // which is precisely the input one of these specs is about.
      const extra = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `POST /rpc/orders/find HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n` +
          `Connection: keep-alive\r\n${extra}\r\n${body}`,
      );

      return { head: () => head };
    },
    /**
     * Resolves once the listener is genuinely closed, which is what `drain`
     * promises. A fresh connection being refused is the only honest observable —
     * the phase moves to `"draining"` a tick before `stopAccepting` runs.
     */
    stoppedAccepting: async <E>(app: App<E>): Promise<void> => {
      const port = await portOf(app);
      await vi.waitUntil(async () => {
        const probe = connect(port, "127.0.0.1");
        const refused = await new Promise<boolean>((resolve) => {
          probe.once("connect", () => resolve(false));
          probe.once("error", () => resolve(true));
        });
        probe.destroy();
        return refused;
      });
    },
    closeAll: (): void => {
      for (const socket of opened) socket.destroy();
    },
  };
};

export type ApiFixtures = {
  /**
   * Starts an app and registers its shutdown. The teardown runs even when the
   * test fails, which is what the `try`/`finally` blocks used to hand-roll —
   * and it keeps the assertion those blocks carried: the app exited `Ok`.
   */
  readonly serve: Serve;
  readonly clientFor: <E>(app: App<E>) => Promise<OrderApiClient>;
  readonly probesFor: <E>(app: App<E>) => Promise<string>;
  readonly statusOf: (url: string) => Promise<number>;
  readonly unmodelled: ReturnType<typeof unmodelledApi>;
  readonly gate: ReturnType<typeof gatedApi>;
  readonly tapped: ReturnType<typeof tappedApi>;
  readonly keepAlive: ReturnType<typeof keepAliveOf>;
};

/**
 * Every spec binds `port: 0` and reads the port back from `Serving.info` — the
 * kernel's own channel for it, which is why this runtime has no `onListening`
 * hook and no `boundPort()` accessor of its own.
 */
const originOf = async <E>(app: App<E>): Promise<string> => `http://127.0.0.1:${await portOf(app)}`;

export const it = test.extend<ApiFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: Serve = (module, options) => {
      const app = start(module, {
        runtime: orpcRuntime({ port: 0 }),
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

  // oxlint-disable-next-line no-empty-pattern -- see above
  keepAlive: async ({}, use) => {
    const keepAlive = keepAliveOf();
    await use(keepAlive);
    keepAlive.closeAll();
  },
});
