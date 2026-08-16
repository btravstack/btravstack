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
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";

import type { ConfigInvalid, Environment } from "@btravstack/config";
import { currentUnit, type RunningApp } from "@btravstack/core";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type RouterContractClient } from "@orpc/contract";
import { OkAsync, fromSafePromise } from "unthrown";
import { test } from "vitest";

import { HttpController } from "./controller.js";
import { HttpHandler } from "./handler.js";
import { HttpModule } from "./http-module.js";
import { HttpConfig, HttpRuntime, httpModule, type HttpInfo } from "./http-runtime.js";
import { HttpRouter } from "./orpc.js";

type Handler = ServiceOf<HttpHandler>;

/**
 * The transport under test with a bare listener where `http()` would put the
 * oRPC one — the internal seam `httpModule` exists for, so the guarantees
 * (`404`/`500`, the unit open until `'close'`, the drain) are exercised without
 * a router in the way. Loopback and an ephemeral port unless told otherwise.
 */
const appOf = (handler: Handler, port = 0) =>
  Module("App")({
    imports: [
      httpModule({ port, hostname: "127.0.0.1" }, Provider(HttpHandler)({ value: handler })),
    ],
    exports: [HttpRuntime],
  });

/** A greeting service, so the router has a real dependency to declare. */
class Greeter extends Port("Greeter")<{ readonly greet: (name: string) => string }> {}

/** Three bare procedures, one nested — the contract is what types the implementation below and the client. */
const helloFragment = { hello: oc };
const nestedFragment = { ping: oc };
const greetingContract = oc.router({ ...helloFragment, boom: oc, nested: nestedFragment });

const greetingImplementation = (greeter: ServiceOf<Greeter>) => ({
  hello: () => OkAsync(greeter.greet("world")),
  boom: () => {
    // oxlint-disable-next-line unthrown/no-throw -- the defect IS the subject under test: oRPC's own collapse to INTERNAL_SERVER_ERROR
    throw new Error("bug");
  },
  nested: { ping: () => OkAsync("pong") },
});

/** The router as a service, built from the greeter it declares — contract-first, on the starter's own router port. */
const greetingRouter = HttpRouter(greetingContract)([Greeter], {
  sync: greetingImplementation,
});

/** Two controllers over the same contract's two halves — what the keyed router composes. */
export const helloController = HttpController("HelloController", helloFragment)([Greeter], {
  sync: (greeter) => ({ hello: () => OkAsync(greeter.greet("world")) }),
});

/**
 * The same implementation carrying a key the contract never declared — only
 * reachable past the types (the assertion is the bypass), which is what
 * `routerOf`'s own guard exists for: the stray key is dropped, not defected on.
 */
const strayRouter = HttpRouter(greetingContract)([Greeter], {
  sync: (greeter) =>
    ({ ...greetingImplementation(greeter), stray: () => OkAsync("stray") }) as ReturnType<
      typeof greetingImplementation
    >,
});

/** The starter as an application uses it: `HttpModule` sugar over a router provider. */
const rpcAppOf = (prefix?: `/${string}`, stray = false) =>
  HttpModule("RpcApp")({
    router: stray ? strayRouter : greetingRouter,
    port: 0,
    hostname: "127.0.0.1",
    ...(prefix === undefined ? {} : { prefix }),
    provides: [Provider(Greeter)({ value: { greet: (name) => `hello ${name}` } })],
  });

/** Whatever `HttpConfig` the graph bound, captured by a provider that depends on it. */
class BoundConfig extends Port("BoundConfig")<{ readonly value: ServiceOf<HttpConfig> }> {}

/** The starter left to configure itself — from the environment, plus whatever `options` pins. */
const configuredAppOf = (options: { readonly port?: number; readonly hostname?: string }) => {
  let bound: ServiceOf<HttpConfig> | undefined;
  return {
    module: Module("ConfiguredApp")({
      imports: [httpModule(options, Provider(HttpHandler)({ value: noop }))],
      provides: [
        Provider(BoundConfig)([HttpConfig], {
          sync: (config) => {
            bound = config;
            return { value: config };
          },
        }),
      ],
      exports: [HttpRuntime],
    }),
    config: () => bound,
  };
};

/** A unit-scoped port whose construction is held open, so a unit's work can be delayed past its client's patience. */
class Slow extends Port("Slow")<{ readonly built: true }> {}

type SlowUnit = {
  readonly module: Module<Slow, never, never>;
  /** Resolves once a unit has started building the module. */
  readonly arrived: Promise<void>;
  /** Lets every held construction finish. */
  readonly release: () => void;
};

const slowUnitOf = (): SlowUnit => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    module: Module("SlowUnit")({
      provides: [
        Provider(Slow)({
          make: () => {
            entered();
            return fromSafePromise(held.then(() => ({ built: true }) as const));
          },
        }),
      ],
      exports: [Slow],
    }),
    arrived,
    release: () => release(),
  };
};

type App = RunningApp<ConfigInvalid, HttpInfo>;

const noop: Handler = (_request, response, _signal) =>
  new Promise<void>((done) => response.end("ok", () => done()));

export type HttpFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * Starts an app on an ephemeral port through `boot`, so its shutdown is the
   * fixture's — on every exit path, a failing assertion included.
   */
  readonly serve: (
    handler?: Handler,
    unit?: SlowUnit["module"],
  ) => Promise<{ readonly app: App; readonly origin: string }>;
  /**
   * An app whose starter binds `HttpConfig` from `env` (plus whatever `options`
   * pins), and what it bound. Shut down by the fixture; a startup failure is
   * the test's to assert on `app.exited`.
   */
  readonly configured: (
    env: Environment,
    options?: { readonly port?: number; readonly hostname?: string },
  ) => {
    readonly app: RunningApp<ConfigInvalid, HttpInfo>;
    readonly config: () => ServiceOf<HttpConfig> | undefined;
  };
  /**
   * The starter proper — `HttpModule` over a router provider — on an
   * ephemeral port, with a typed oRPC client pointed at it. Shut down by the
   * fixture.
   */
  readonly rpc: (
    prefix?: `/${string}`,
    /** Serve `strayRouter` — the implementation with a key the contract never declared — instead. */
    stray?: boolean,
  ) => Promise<{
    readonly origin: string;
    readonly client: RouterContractClient<typeof greetingContract>;
  }>;
  /** A `StartOptions.unit` module whose provider builds only once `release()` is called. */
  readonly slowUnit: SlowUnit;
  /** An app started on an explicit port, for the failure paths. Shut down by the fixture. */
  readonly appOnPort: (port: number) => App;
  readonly occupied: { readonly appOnTakenPort: App };
  /** The `http.Server` the runtime just created. Asserted here so a test body cannot pass on an empty capture. */
  readonly boundServer: () => Server;
  /** A handler held open until `release()`, so a test can observe a unit in flight. */
  readonly gate: {
    readonly handler: Handler;
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
  /**
   * Like `gate`, except the handler flushes its headers before holding — the
   * state a streamed response is in, and the one `retire`'s `headersSent`
   * branch exists for. This package's own router never produces it
   * (`writeHead` and `end` sit adjacent, with nothing async between), but a
   * handler is free to.
   */
  readonly streamedGate: {
    readonly handler: Handler;
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
  /** A handler that records the ambient record the kernel opened for its unit. */
  readonly traced: {
    readonly handler: Handler;
    readonly seen: () => readonly (string | undefined)[];
  };
  /**
   * A raw keep-alive connection held BUSY across a drain. `fetch` cannot express
   * it: undici owns its pool, and `Connection` is hop-by-hop so it never reaches
   * the `Response`. Busy is the point — `closeIdleConnections()` reaches every
   * *idle* connection and no others.
   */
  readonly keepAlive: {
    readonly call: (origin: string) => Promise<{
      readonly head: () => Promise<string>;
      /** Resolves once the raw socket itself closes — the observable a header can no longer carry once it is already on the wire. */
      readonly closed: () => Promise<void>;
    }>;
    readonly stoppedAccepting: (origin: string) => Promise<void>;
  };
  /** The controllers the keyed router form composes. */
  readonly controllers: { readonly controller: typeof helloController };
};

export const it = test.extend<HttpFixtures>({
  boot: bootFixture(),

  serve: async ({ boot }, use) => {
    await use(async (handler = noop, unit) => {
      const app = boot(appOf(handler), unit === undefined ? {} : { unit });
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { app, origin: `http://127.0.0.1:${info.port}` };
    });
  },

  configured: async ({ boot }, use) => {
    await use((env, options = {}) => {
      const { module, config } = configuredAppOf(options);
      return { app: boot(module, { env }), config };
    });
  },

  rpc: async ({ boot }, use) => {
    await use(async (prefix, stray) => {
      const app = boot(rpcAppOf(prefix, stray));
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: RouterContractClient<typeof greetingContract> = createORPCClient(
        new RPCLink({ origin, url: prefix ?? "/rpc" }),
      );
      return { origin, client };
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  slowUnit: async ({}, use) => {
    await use(slowUnitOf());
  },

  appOnPort: async ({ boot }, use) => {
    await use((port) => boot(appOf(noop, port)));
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

  // oxlint-disable-next-line no-empty-pattern -- see above
  boundServer: async ({}, use) => {
    await use(() => {
      const server = capturedServers.at(-1);
      assert.ok(server !== undefined, "the node:http mock did not intercept createServer");
      return server;
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });

    await use({
      handler: (_request, response, _signal) => {
        entered();
        return held.then(() => new Promise<void>((done) => response.end("late", () => done())));
      },
      arrived,
      release: () => open(),
    });

    open();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  streamedGate: async ({}, use) => {
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });

    await use({
      handler: (_request, response, _signal) => {
        response.writeHead(200);
        entered();
        return held.then(() => new Promise<void>((done) => response.end("late", () => done())));
      },
      arrived,
      release: () => open(),
    });

    open();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  traced: async ({}, use) => {
    const seen: (string | undefined)[] = [];
    await use({
      handler: (_request, response, _signal) => {
        seen.push(currentUnit()?.traceId);
        return new Promise<void>((done) => response.end("ok", () => done()));
      },
      seen: () => seen,
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  keepAlive: async ({}, use) => {
    const opened: Socket[] = [];
    const portOf = (origin: string): number => Number(new URL(origin).port);

    await use({
      call: async (origin) => {
        const socket = connect(portOf(origin), "127.0.0.1");
        // A raw socket with no `'error'` listener throws on reset, and the drain
        // under test resets it by design.
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
        const closed = once(socket, "close").then(() => undefined);

        socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
        return { head: () => head, closed: () => closed };
      },
      // A fresh connection being refused is the only honest observable: the phase
      // moves to `"draining"` a tick before `stopAccepting` runs.
      stoppedAccepting: async (origin) => {
        const port = portOf(origin);
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
    });

    for (const socket of opened) socket.destroy();
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  controllers: async ({}, use) => {
    await use({ controller: helloController });
  },
});
