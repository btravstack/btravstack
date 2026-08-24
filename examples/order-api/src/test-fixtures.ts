import assert from "node:assert/strict";

import type { Env } from "@btravstack/config";
import type { RunningApp, StartOptions } from "@btravstack/core";
import { Provider, type Module, type Scope, type ServiceOf } from "@btravstack/di";
import { CustomerRepository, OrderRepository } from "@btravstack/example-order-application";
import {
  Customer,
  CustomerNotFound,
  OrderNotFound,
  placeOrder,
  type Order,
  type TenantId,
} from "@btravstack/example-order-domain";
import type { HttpInfo, HttpRuntime } from "@btravstack/http";
import { uuidv7 } from "@btravstack/internal-test-infra/uuid";
import {
  Logger,
  LoggerConfig,
  createLogger,
  type Line,
  type Sink,
} from "@btravstack/observability";
import { bootFixture, overridden, type Boot } from "@btravstack/testing";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { inject, test } from "vitest";

import { createOrderApiClient, type OrderApiClient } from "./client.js";
import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

const anOrder = (id: string, quantity: number): Order => placeOrder(id, quantity).getOrThrow();

/**
 * Both repositories as overrides, so one call closes both verticals the way
 * the two persistence modules do. Only the orders half varies per
 * spec; the customers one holds a single registered customer, which is all
 * that slice's one procedure needs to answer.
 */
const persistenceOf = (repository: ServiceOf<OrderRepository>) => [
  Provider(OrderRepository)({ value: repository }),
  Provider(CustomerRepository)({
    value: {
      find: (_tenantId: TenantId, id: string) =>
        id === "0199a1e0-0000-7000-8000-0000000000c1"
          ? OkAsync(Customer.make({ id, name: "Ada" }).getOrThrow())
          : ErrAsync(new CustomerNotFound({ id })),
    },
  }),
];

/** A sink that keeps what it was given, so a spec asserts on the line's fields rather than on a string. */
const recorderOf = () => {
  const lines: Line[] = [];
  return { sink: (line: Line) => lines.push(line), lines: (): readonly Line[] => lines };
};

/**
 * `OrderApi` ITSELF with persistence and the logger overridden — not a
 * parallel root any more (issue #63). The slices still bring the Prisma
 * providers with them; `overridden` REPLACES those providers by port, so the
 * stub answers and the real adapter is never constructed. The database
 * client behind it still opens — an override replaces one provider, never a
 * subsystem — which is fine here: every spec's environment carries the
 * shared database anyway. The sink defaults
 * to a no-op: these roots are booted to exercise the transport, and the real
 * `jsonSink()` would put the application's lines in the test runner's own
 * output; the logger override reads the real `LoggerConfig`, so `boot`'s
 * `LOG_LEVEL` filters exactly as the composed `observability()` did.
 */
const apiWith = (repository: ServiceOf<OrderRepository>, sink: Sink = () => {}) =>
  overridden(OrderApi, [
    ...persistenceOf(repository),
    Provider(Logger)(
      { config: LoggerConfig },
      { sync: ({ config }) => createLogger(sink, config.level) },
    ),
  ]);

/**
 * The real root's composition with a recording sink in place of stdout.
 *
 * `observability({ sink })` IS the seam a spec reads the running graph's lines
 * through, which is why the `tapped(OrderApi, [Logger])` this replaces is
 * gone: the old placeholder port could only be read back because it kept its
 * own array, and reaching into the graph for that instance was the price. A
 * sink is a value the composition takes, so what comes back is the `Line`
 * itself — `unit.traceId` as a field, not a prefix parsed out of a string.
 * `OrderApi` itself here too, with only the logger overridden — the drift
 * this fixture used to invite ("mirror the real root by hand") is now a
 * `WiringDefect` the moment the root stops providing `Logger`.
 */
const recordingApi = () => {
  const recorder = recorderOf();
  return {
    // `"trace"` pinned rather than bound: `boot`'s `LOG_LEVEL` silences the
    // real root, and this root exists to be read.
    api: overridden(OrderApi, [Provider(Logger)({ value: createLogger(recorder.sink, "trace") })]),
    lines: recorder.lines,
  };
};

/**
 * The stub root at rest: nothing hangs, nothing blows up, and the customer
 * `0199a1e0-0000-7000-8000-0000000000c1` is registered. What the customers slice's success path needs, which
 * the real root cannot give it — its database is born empty inside the graph
 * and no procedure registers anyone.
 */
const stubbedApi = () =>
  apiWith({
    save: (_tenantId, order) => OkAsync(order),
    find: (_tenantId, id) => ErrAsync(new OrderNotFound({ id })),
    remove: () => OkAsync(),
  });

/**
 * A composition root whose repository fails in a way nobody modelled: no
 * `qualify` triaged the rejection, so it is a defect and never reaches the
 * contract's declared error map.
 */
const unmodelledApi = () =>
  apiWith({
    save: (_tenantId, order) => OkAsync(order),
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
      save: (_tenantId, order) => OkAsync(order),
      find: (_tenantId, id) => {
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
   * This test's tenant, and nobody else's. The database is shared by every
   * workspace's run — one migration for the whole gate rather than one per
   * test — so a UUID here is what keeps one spec's `0199a1e0-0000-7000-8000-000000000001` from being another's.
   * Every call names it, because the contract does.
   */
  readonly tenant: string;
  /**
   * Starts an app on an ephemeral loopback port — `env: { PORT: "0", HOST:
   * "127.0.0.1" }`, which is how every composition here, the real one
   * included, gets bound — with `RequestModule` forked around every request,
   * through `boot`: its shutdown is the fixture's, on every exit path.
   *
   * The module's `X` is pinned to the two ports every composition here
   * exports rather than left generic: `start`'s gate is a marker intersected
   * onto `module`, proven at the call site, and no proof is available inside a
   * helper generic in the module's own exports. `HttpRuntime` is what `start`
   * resolves, and `Logger` is for the gate's OTHER half — `RequestModule`,
   * passed as `StartOptions.unit`, reads it out of the parent.
   */
  readonly serve: <E>(
    module: Module<HttpRuntime | Logger, E, Scope | Env>,
    options?: Pick<StartOptions, "drainTimeoutMs" | "probes">,
  ) => RunningApp<E, HttpInfo>;
  /**
   * A client already carrying credentials for this test's tenant — the shape
   * every spec here wants, since the contract marks the orders fragment and an
   * anonymous call to it never reaches a use case. `u-1` is a user id and
   * nothing reads it; what the token establishes that a test cares about is
   * the tenant.
   */
  readonly clientFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<OrderApiClient>;
  /**
   * The same client with the `authorization` header stated verbatim, and
   * absent when the token is `undefined` — what a spec about the refusal
   * itself needs, rather than one about what a caller is then allowed to do.
   */
  readonly clientWith: <E>(
    app: RunningApp<E, HttpInfo>,
    token: string | undefined,
  ) => Promise<OrderApiClient>;
  /**
   * A client presenting an API key and no bearer token — the `service`
   * scheme's credential. `export` names `user` first, so this is the caller
   * that has to reach the second requirement to be served at all.
   */
  readonly serviceClientFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<OrderApiClient>;
  readonly probesFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<string>;
  readonly statusOf: (url: string) => Promise<number>;
  /** The real composition root. */
  readonly api: typeof OrderApi;
  /** The same two slices over stub persistence, with one customer registered. */
  readonly stubbed: ReturnType<typeof stubbedApi>;
  readonly unmodelled: ReturnType<typeof unmodelledApi>;
  readonly gate: ReturnType<typeof gatedApi>;
  /** The real root's composition, plus everything its logger wrote. */
  readonly recording: ReturnType<typeof recordingApi>;
};

/**
 * The port comes back from `Serving.info` — the kernel's own channel for it,
 * which is why this runtime has no `onListening` hook and no `boundPort()`
 * accessor of its own.
 */
const originOf = async <E>(app: RunningApp<E, HttpInfo>): Promise<string> =>
  `http://127.0.0.1:${await portOf(app)}`;

export const it = test.extend<ApiFixtures>({
  // `LOG_LEVEL: "fatal"` is what keeps the real `OrderApi` — whose sink is the
  // production `jsonSink()` on stdout — from writing its lines into the
  // runner's own output. The roots a spec reads back pin their level instead.
  boot: bootFixture({
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      LOG_LEVEL: "fatal",
      DATABASE_URL: inject("__ORDERS_DATABASE_URL__"),
    },
  }),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tenant: async ({}, use) => {
    await use(uuidv7());
  },

  serve: async ({ boot }, use) => {
    await use((module, options) => boot(module, { unit: RequestModule, ...options }));
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  clientWith: async ({}, use) => {
    await use(async (app, token) =>
      createOrderApiClient(
        await originOf(app),
        "/rpc",
        token === undefined ? {} : { authorization: token },
      ),
    );
  },

  clientFor: async ({ tenant, clientWith }, use) => {
    await use(async (app) => clientWith(app, `Bearer ${tenant}:u-1`));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  serviceClientFor: async ({}, use) => {
    await use(async (app) =>
      createOrderApiClient(await originOf(app), "/rpc", { "x-api-key": "reporting" }),
    );
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
  stubbed: async ({}, use) => {
    await use(stubbedApi());
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
  recording: async ({}, use) => {
    await use(recordingApi());
  },
});
