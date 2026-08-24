import type { IncomingHttpHeaders, Server } from "node:http";

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
import { authenticated } from "@btravstack/contract";
import { currentUnit, type RunningApp } from "@btravstack/core";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type as ocType, type RouterContractClient } from "@orpc/contract";
import { CORSHandlerPlugin } from "@orpc/server/plugins";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { test } from "vitest";

import { HttpAuthenticator, Unauthenticated, authenticatorPort } from "./auth.js";
import { defineHttp } from "./define-http.js";
import { HttpHandler } from "./handler.js";
import { HttpModule } from "./http-module.js";
import {
  HttpConfig,
  HttpRuntime,
  http,
  httpModule,
  type HttpInfo,
  type HttpOptions,
} from "./http-runtime.js";

type Handler = ServiceOf<HttpHandler>;

/** Everything the unmarked fixtures below mint: no authenticators, no schemes. */
const publicApi = defineHttp();

/**
 * The transport under test with a bare listener where `http()` would put the
 * oRPC one — the internal seam `httpModule` exists for, so the guarantees
 * (`404`/`500`, the unit open until `'close'`, the drain) are exercised without
 * a router in the way. Loopback and an ephemeral port unless told otherwise.
 */
const appOf = (handler: Handler, port = 0, securityHeaders?: HttpOptions["securityHeaders"]) =>
  Module("App")({
    imports: [
      httpModule(
        {
          port,
          hostname: "127.0.0.1",
          ...(securityHeaders === undefined ? {} : { securityHeaders }),
        },
        Provider(HttpHandler)({ value: handler }),
      ),
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
const greetingRouter = publicApi.HttpRouter(greetingContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => greetingImplementation(greeter),
  },
);

/**
 * The composing form's own contract, over the same two fragments.
 * `greetingContract` is the deps form's fixture, carrying its `boom` defect and
 * the stray key smuggled past the types, and the two arms are worth exercising
 * side by side.
 */
const slicedContract = oc.router({ greetings: helloFragment, echoes: nestedFragment });

/** Two pieces over `slicedContract`'s two keys — the key is the port's name. */
export const helloController = publicApi.HttpController(slicedContract, "greetings")(
  { greeter: Greeter },
  { sync: ({ greeter }) => ({ hello: () => OkAsync(greeter.greet("world")) }) },
);

const echoesController = publicApi.HttpController(
  slicedContract,
  "echoes",
)({
  sync: () => ({ ping: () => OkAsync("pong") }),
});

/**
 * An arm-only router whose `sync` records its own arity. The arm-only form is
 * typed `() => Implementation`, so the runtime must hand it nothing; passing a
 * record would be invisible to an arrow and visible to a rest parameter.
 */
export const armOnlyRouterRecording = () => {
  let seen = -1;
  const provider = publicApi.HttpRouter(oc.router({ greetings: helloFragment }))({
    sync: (...args: readonly unknown[]) => {
      seen = args.length;
      return { greetings: { hello: () => OkAsync("hello world") } };
    },
  } as never);
  return { provider, arity: () => seen };
};

/** The same kind of API as `greetingRouter`, composed from pieces instead of one `sync`. */
const slicedRouter = publicApi.HttpRouter(slicedContract)([helloController, echoesController]);

/** `HttpModule` over the composed router, mirroring `rpcAppOf`. */
const rpcSlicedAppOf = () =>
  HttpModule("RpcSlicedApp")({
    router: slicedRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [
      helloController,
      echoesController,
      Provider(Greeter)({ value: { greet: (name) => `hello ${name}` } }),
    ],
  });

/**
 * What this deployment knows about a caller. The contract names no identity
 * type at all, so `defineHttp` is the only place one is stated — and the only
 * route by which a handler gets a readable `context.principal`.
 */
type Identity = { readonly tenantId: string; readonly userId: string };

const userAuthenticator = HttpAuthenticator<Identity>()({
  sync: () => (headers) => {
    if (headers.authorization === "Bearer boom") {
      return OkAsync().map((): Identity => {
        // oxlint-disable-next-line unthrown/no-throw -- an authenticator bug IS the subject under test, and a throw inside a combinator is the only way to mint a Defect
        throw new Error("authenticator bug");
      });
    }
    return headers.authorization === "Bearer good"
      ? OkAsync({ tenantId: "t-good", userId: "u-good" })
      : ErrAsync(new Unauthenticated());
  },
});

/** One scheme, `user` — the registry every marked fixture below is typed by. */
const api = defineHttp({ authenticators: { user: userAuthenticator } });

/** One protected fragment and one public one — the marker's runtime half, end to end. */
const whoami = oc
  .input(ocType<{ readonly id: string }>())
  .output(ocType<{ readonly userId: string }>());
const ping = oc.output(ocType<{ readonly ok: true }>());
const authedContract = { orders: authenticated({ user: [] })({ whoami }), health: { ping } };

/** Counted so a test can assert the handler was never entered on a refusal. */
let authedRuns = 0;

const authedOrdersController = api.HttpController(
  authedContract,
  "orders",
)({
  sync: () => ({
    whoami: ({ context }) => {
      authedRuns += 1;
      return OkAsync({ userId: context.principal.userId });
    },
  }),
});

const authedHealthController = api.HttpController(
  authedContract,
  "health",
)({
  sync: () => ({ ping: () => OkAsync({ ok: true as const }) }),
});

const authedRouter = api.HttpRouter(authedContract)([
  authedOrdersController,
  authedHealthController,
]);

/**
 * The same marked contract through the deps form, so the scheme's own key on
 * the deps record is pinned for both arms of `build`.
 */
const authedPositionalRouter = api.HttpRouter(authedContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      orders: {
        whoami: ({ context }) => OkAsync({ userId: greeter.greet(context.principal.userId) }),
      },
      health: { ping: () => OkAsync({ ok: true as const }) },
    }),
  },
);

/** `HttpModule` over the protected router; the authenticator rides in with it. */
const rpcAuthedAppOf = () =>
  HttpModule("RpcAuthedApp")({
    router: authedRouter,
    port: 0,
    hostname: "127.0.0.1",
    provides: [authedOrdersController, authedHealthController],
  });

/**
 * The marker on the contract's ROOT, where the walk has no `contract[key]` to
 * read it from: every leaf inherits it, the same way `Implementation<C>`'s
 * record arm inherits the enclosing requirements.
 */
const rootMarkedContract = authenticated({ user: [] })({ orders: { whoami } });

let rootMarkedRuns = 0;

const rootMarkedRouter = api.HttpRouter(rootMarkedContract)({
  sync: () => ({
    orders: {
      whoami: ({ context }) => {
        rootMarkedRuns += 1;
        return OkAsync({ userId: context.principal.userId });
      },
    },
  }),
});

const rpcRootMarkedAppOf = () =>
  HttpModule("RpcRootMarkedApp")({
    router: rootMarkedRouter,
    port: 0,
    hostname: "127.0.0.1",
  });

/**
 * The other arm of `HttpAuthenticator`: one that DECLARES a dependency — a JWT
 * verifier, a key set, a token table — which is the form every adopter writes
 * and the one `defineHttp` binds through `Provider(port)(deps, arm)`.
 */
class TokenTable extends Port("TokenTable")<(token: string) => Identity | undefined> {}

const verifying = defineHttp({
  authenticators: {
    user: HttpAuthenticator<Identity>()(
      { tokens: TokenTable },
      {
        sync:
          ({ tokens }) =>
          (headers) => {
            const claimed = tokens(headers.authorization ?? "");
            return claimed === undefined ? ErrAsync(new Unauthenticated()) : OkAsync(claimed);
          },
      },
    ),
  },
});

const verifiedRouter = verifying.HttpRouter({
  orders: authenticated({ user: [] })({ whoami }),
})({
  sync: () => ({
    orders: { whoami: ({ context }) => OkAsync({ userId: context.principal.userId }) },
  }),
});

const rpcVerifiedAppOf = () =>
  HttpModule("RpcVerifiedApp")({
    router: verifiedRouter,
    port: 0,
    hostname: "127.0.0.1",
    imports: [
      Module("Tokens")({
        provides: [
          Provider(TokenTable)({
            value: (token) =>
              token === "Bearer keyed" ? { tenantId: "t-keyed", userId: "u-keyed" } : undefined,
          }),
        ],
        exports: [TokenTable],
      }),
    ],
  });

/**
 * The substitution seam `authenticatorPort` exists for: a hand-rolled
 * composition provides its OWN authenticator on the scheme's port and never
 * spreads `router.authenticators` — recomposition, this repo's stated way to
 * swap an adapter, not a second `defineHttp` registry and not a provider
 * layered over one (di refuses two providers for one port). The real,
 * `TokenTable`-backed authenticator is not in this graph at all, which is the
 * point: the stub composition never builds the verifier.
 */
const rpcSubstitutedAppOf = () =>
  Module("RpcSubstitutedApp")({
    imports: [http({ port: 0, hostname: "127.0.0.1" })],
    provides: [
      verifiedRouter,
      Provider(authenticatorPort("user"))({
        value: () => OkAsync({ userId: "u-stub" }),
      }),
    ],
    exports: [HttpRuntime],
  });

/** `Bearer ${token}`, or no credentials at all when `token` is `undefined`. */
const linkOf = (origin: string, token: string | undefined) =>
  new RPCLink({
    origin,
    url: "/rpc",
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

/** The marker is erased from the client's view — it is a phantom key, never a procedure. */
type AuthedClient = RouterContractClient<{
  readonly orders: { readonly whoami: typeof whoami };
  readonly health: { readonly ping: typeof ping };
}>;

type RootMarkedClient = RouterContractClient<{
  readonly orders: { readonly whoami: typeof whoami };
}>;

/**
 * The same implementation carrying a key the contract never declared — only
 * reachable past the types (the assertion is the bypass), which is what
 * `routerOf`'s own guard exists for: the stray key is dropped, not defected on.
 */
const strayRouter = publicApi.HttpRouter(greetingContract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) =>
      ({ ...greetingImplementation(greeter), stray: () => OkAsync("stray") }) as ReturnType<
        typeof greetingImplementation
      >,
  },
);

/** The starter as an application uses it: `HttpModule` sugar over a router provider. */
const rpcAppOf = (prefix?: `/${string}`, stray = false) =>
  HttpModule("RpcApp")({
    router: stray ? strayRouter : greetingRouter,
    port: 0,
    hostname: "127.0.0.1",
    ...(prefix === undefined ? {} : { prefix }),
    provides: [Provider(Greeter)({ value: { greet: (name) => `hello ${name}` } })],
  });

/**
 * A one-procedure `greet` contract, named for the plugin test's own request
 * path — `greetingContract`'s `hello` would not match `/rpc/greet` and the
 * CORS plugin only decorates a MATCHED response.
 */
const corsContract = oc.router({
  greet: oc.input(ocType<{ readonly name: string }>()).output(ocType<string>()),
});

const corsRouter = publicApi.HttpRouter(corsContract)({
  sync: () => ({ greet: ({ input }) => OkAsync(`hello ${input.name}`) }),
});

/** The same starter shape as `rpcAppOf`, with oRPC's CORS plugin configured. */
const rpcWithCorsAppOf = () =>
  HttpModule("RpcWithCorsApp")({
    router: corsRouter,
    port: 0,
    hostname: "127.0.0.1",
    plugins: [new CORSHandlerPlugin({ origin: () => "https://example.test" })],
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
        Provider(BoundConfig)(
          { config: HttpConfig },
          {
            sync: ({ config }) => {
              bound = config;
              return { value: config };
            },
          },
        ),
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
    securityHeaders?: HttpOptions["securityHeaders"],
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
  /** The pieces the composing router form takes, and what the unmarked router they build declares. */
  readonly controllers: {
    readonly controller: typeof helloController;
    readonly unmarkedRouterDeps: readonly string[];
  };
  /**
   * The starter over a router composed from an array of pieces, one per
   * contract key — the same shape as `rpc`, but built from `slicedRouter`.
   * Shut down by the fixture.
   */
  readonly rpcSliced: () => Promise<{
    readonly origin: string;
    readonly client: RouterContractClient<typeof slicedContract>;
  }>;
  /**
   * The starter over a contract whose `orders` fragment is `authenticated(...)`,
   * with an authenticator that accepts exactly one token — router, controllers
   * and authenticator all minted by one `defineHttp(...)`. Shut down by
   * the fixture; the handler's run count is reset before the test body.
   */
  readonly rpcAuthed: {
    /** A typed client presenting `Bearer ${token}`, or no credentials at all when `token` is `undefined`. */
    readonly clientWith: (token: string | undefined) => AuthedClient;
    /** How many times the protected handler has been entered. */
    readonly handlerRuns: () => number;
    readonly url: string;
  };
  /**
   * The starter over a contract whose **root** is `authenticated(...)` — the
   * case no `contract[key]` lookup can see. Shut down by the fixture.
   */
  readonly rpcRootMarked: {
    readonly clientWith: (token: string | undefined) => RootMarkedClient;
    readonly handlerRuns: () => number;
  };
  /** What each `HttpRouter` arm declares as its dependencies over the same marked contract. */
  readonly authedRouterDeps: {
    readonly keyed: readonly string[];
    readonly fromDeps: readonly string[];
  };
  /**
   * The starter over a router whose scheme's authenticator DECLARES a
   * dependency, resolved by an imported module — the form `defineHttp` binds
   * through `Provider(port)(deps, arm)`. Shut down by the fixture.
   */
  readonly rpcVerified: (token: string) => RootMarkedClient;
  /** The same router with the `user` scheme's authenticator substituted on its port. Shut down by the fixture. */
  readonly rpcSubstituted: (token: string) => RootMarkedClient;
  /** The starter over a router with oRPC's CORS plugin configured. Shut down by the fixture. */
  readonly rpcWithCors: { readonly url: string };
  /** A bare request's headers — the one argument an authenticator is handed. */
  readonly headers: IncomingHttpHeaders;
};

export const it = test.extend<HttpFixtures>({
  boot: bootFixture(),

  serve: async ({ boot }, use) => {
    await use(async (handler = noop, unit, securityHeaders) => {
      const app = boot(
        appOf(handler, undefined, securityHeaders),
        unit === undefined ? {} : { unit },
      );
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
    await use({
      controller: helloController,
      unmarkedRouterDeps: slicedRouter.deps.map((dep) => dep.portId),
    });
  },

  rpcSliced: async ({ boot }, use) => {
    await use(async () => {
      const app = boot(rpcSlicedAppOf());
      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      const origin = `http://127.0.0.1:${info.port}`;
      const client: RouterContractClient<typeof slicedContract> = createORPCClient(
        new RPCLink({ origin, url: "/rpc" }),
      );
      return { origin, client };
    });
  },

  rpcAuthed: async ({ boot }, use) => {
    const app = boot(rpcAuthedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    authedRuns = 0;

    await use({
      clientWith: (token) => createORPCClient(linkOf(origin, token)),
      handlerRuns: () => authedRuns,
      url: `${origin}/rpc`,
    });
  },

  rpcRootMarked: async ({ boot }, use) => {
    const app = boot(rpcRootMarkedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    rootMarkedRuns = 0;

    await use({
      clientWith: (token) => createORPCClient(linkOf(origin, token)),
      handlerRuns: () => rootMarkedRuns,
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  authedRouterDeps: async ({}, use) => {
    await use({
      keyed: authedRouter.deps.map((dep) => dep.portId),
      fromDeps: authedPositionalRouter.deps.map((dep) => dep.portId),
    });
  },

  rpcVerified: async ({ boot }, use) => {
    const app = boot(rpcVerifiedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    await use((token) => createORPCClient(linkOf(origin, token)));
  },

  rpcSubstituted: async ({ boot }, use) => {
    const app = boot(rpcSubstitutedAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    const origin = `http://127.0.0.1:${info.port}`;
    await use((token) => createORPCClient(linkOf(origin, token)));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  headers: async ({}, use) => {
    await use({});
  },

  rpcWithCors: async ({ boot }, use) => {
    const app = boot(rpcWithCorsAppOf());
    const info = (await app.runtimeInfo()).get();
    assert.ok(info !== undefined, "the runtime published no Serving.info");
    await use({ url: `http://127.0.0.1:${info.port}` });
  },
});
