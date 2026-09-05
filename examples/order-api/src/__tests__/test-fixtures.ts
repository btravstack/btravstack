import assert from "node:assert/strict";

import type { Env } from "@btravstack/config";
import { page } from "@btravstack/contract";
import {
  type RunningApp,
  type StartOptions,
  Logger,
  type Meter,
  type Tracer,
} from "@btravstack/core";
import { Provider, type Module, type Scope, type ServiceOf } from "@btravstack/di";
import {
  CustomerRepository,
  MalformedCursor,
  OrderRepository,
} from "@btravstack/example-order-application";
import {
  Customer,
  CustomerNotFound,
  OrderNotFound,
  placeOrder,
  type Order,
  type TenantId,
  type CustomerId,
  type OrderId,
} from "@btravstack/example-order-domain";
import type { HttpHandler, HttpInfo, HttpRuntime } from "@btravstack/http-server";
import { LoggerConfig, createLogger, type Line, type Sink } from "@btravstack/observability";
import { bootFixture, overridden, type Boot } from "@btravstack/testing";
import request from "supertest";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { uuidv7 } from "uuidv7";
import { inject, test } from "vitest";

import { createOrderApiClient, type OrderApiClient } from "../client.js";
import { OrderApi } from "../module.js";

const anOrder = (id: string, quantity: number): Order => placeOrder(id, quantity).getOrThrow();

/** The two rows the listing stub pages over, fixed so a spec can name them. */
const FIRST_ID = "0199a1e0-0000-7000-8000-00000000000a";
const SECOND_ID = "0199a1e0-0000-7000-8000-00000000000b";

/**
 * Both repositories as overrides, so one call closes both verticals. Only the
 * orders half varies per spec; the customers one holds a single registered
 * customer.
 */
const persistenceOf = (repository: ServiceOf<OrderRepository>) => [
  Provider(OrderRepository)({ inject: {}, value: repository }),
  Provider(CustomerRepository)({
    inject: {},
    value: {
      find: (_tenantId: TenantId, id: string) =>
        id === "0199a1e0-0000-7000-8000-0000000000c1"
          ? OkAsync(Customer.make({ id, name: "Ada" }).getOrThrow())
          : ErrAsync(new CustomerNotFound({ id: id as CustomerId })),
    },
  }),
];

/** A sink that keeps what it was given, so a spec asserts on the line's fields rather than on a string. */
const recorderOf = () => {
  const lines: Line[] = [];
  return { sink: (line: Line) => lines.push(line), lines: (): readonly Line[] => lines };
};

/**
 * `OrderApi` ITSELF with persistence and the logger overridden, not a parallel
 * root: `overridden` REPLACES those providers by port, so the stub answers and
 * the real adapter is never constructed. The database client behind it still
 * opens — an override replaces one provider, never a subsystem.
 *
 * The sink defaults to a no-op, since the real `jsonSink()` would put the
 * application's lines in the runner's own output.
 */
const apiWith = (repository: ServiceOf<OrderRepository>, sink: Sink = () => {}) =>
  overridden(OrderApi, [
    ...persistenceOf(repository),
    Provider(Logger)({
      inject: { config: LoggerConfig },
      sync: ({ config }) => createLogger(sink, config.level),
    }),
  ]);

/**
 * The real root's composition with a recording sink in place of stdout. A sink
 * is a value the composition takes, so what comes back is the `Line` itself —
 * `unit.traceId` as a field, not a prefix parsed out of a string.
 */
const recordingApi = () => {
  const recorder = recorderOf();
  return {
    // `"trace"` pinned rather than bound: `boot`'s `LOG_LEVEL` silences the
    // real root, and this root exists to be read.
    api: overridden(OrderApi, [
      Provider(Logger)({ inject: {}, value: createLogger(recorder.sink, "trace") }),
    ]),
    lines: recorder.lines,
  };
};

/**
 * The real root with a customers repository that COUNTS its reads, which is
 * how a spec tells a cache hit from a second query — the only externally
 * visible difference between the two is that one of them happened.
 */
const countingCustomers = () => {
  let reads = 0;
  return {
    api: overridden(OrderApi, [
      Provider(CustomerRepository)({
        inject: {},
        value: {
          find: (_tenantId: TenantId, id: string) => {
            reads += 1;
            return id === "0199a1e0-0000-7000-8000-0000000000c1"
              ? OkAsync(Customer.make({ id, name: "Ada" }).getOrThrow())
              : ErrAsync(new CustomerNotFound({ id: id as CustomerId }));
          },
        },
      }),
    ]),
    reads: () => reads,
  };
};

/**
 * The stub root at rest: nothing hangs, nothing blows up, and one customer is
 * registered — what the customers slice's success path needs and the real root
 * cannot give it, since no procedure registers anyone.
 */
const stubbedApi = () =>
  apiWith({
    save: (_tenantId, order) => OkAsync(order),
    find: (_tenantId, id) => ErrAsync(new OrderNotFound({ id: id as OrderId })),
    // One page with more behind it, and a cursor nobody but the stub can read —
    // which is the point: `after` is opaque above the adapter, so the specs
    // assert the round trip rather than the string.
    //
    // Only the cursors it ISSUED move the listing; every other one is
    // `MalformedCursor`. A stub that accepted any defined cursor would let a
    // round-trip test pass on an altered cursor, which is the one thing that
    // test exists to rule out. Two pages, so `before` has somewhere to go back
    // to — the direction a "previous" link exercises.
    list: (_tenantId, { after, before }) => {
      const first = page([anOrder(FIRST_ID, 1)], { previous: null, next: "page-1-end" });
      if (before !== undefined)
        return before === "page-2-start"
          ? OkAsync(first)
          : ErrAsync(new MalformedCursor({ cursor: before }));
      if (after === undefined) return OkAsync(first);
      return after === "page-1-end"
        ? OkAsync(page([anOrder(SECOND_ID, 2)], { previous: "page-2-start", next: null }))
        : ErrAsync(new MalformedCursor({ cursor: after }));
    },
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
    list: () => OkAsync(page([], { previous: null, next: null })),
    remove: () => OkAsync(),
  });

/**
 * A repository whose `find` never settles until `release()` is called, and whose
 * `arrived` reports the moment the request reached it: the drain specs turn on
 * knowing a unit is genuinely in flight before the drain starts.
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
      list: () => OkAsync(page([], { previous: null, next: null })),
      remove: () => OkAsync(),
    }),
    arrived,
    release: () => release(),
  };
};

/**
 * `runtimeInfo()` carries `E = never`, so `getOrThrow()` does not typecheck —
 * `get()` plus an assertion is the shape this module uses throughout.
 */
const portOf = async <E>(app: RunningApp<E, HttpInfo>): Promise<number> => {
  const info = (await app.runtimeInfo()).get();
  assert.ok(info !== undefined, "the runtime published no Serving.info");
  return info.port;
};

/** Derived rather than deep-imported: supertest's `exports` map does not name the agent type publicly, and `supertest/lib/agent.js` is internal layout an upgrade may move. */
type TestAgent = ReturnType<typeof request>;

export type ApiFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * This test's tenant, and nobody else's: the database is shared by every
   * workspace's run, so a UUID here is what keeps one spec's order id from being
   * another's.
   */
  readonly tenant: string;
  /**
   * Starts an app on an ephemeral loopback port, through `boot` — so its
   * shutdown is the fixture's. `RequestModule` is forked by the answerers
   * themselves, per `OrderApi`'s own `unit` option — nothing here supplies it.
   *
   * The module's `X` is pinned rather than left generic: `start`'s gate is
   * proven at the call site, and no proof is available inside a helper generic
   * in the module's own exports.
   */
  readonly serve: <E>(
    module: Module<HttpRuntime | HttpHandler | Logger | Tracer | Meter, E, Scope | Env>,
    options?: Pick<StartOptions, "drainTimeoutMs" | "probes">,
  ) => RunningApp<E, HttpInfo>;
  /**
   * A client already carrying credentials for this test's tenant — what every
   * spec here wants, since an anonymous call to the marked fragment never
   * reaches a use case.
   */
  readonly clientFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<OrderApiClient>;
  /**
   * The same client with the `authorization` header stated verbatim, and absent
   * when the token is `undefined` — what a spec about the refusal itself needs.
   */
  readonly clientWith: <E>(
    app: RunningApp<E, HttpInfo>,
    token: string | undefined,
  ) => Promise<OrderApiClient>;
  /**
   * A client presenting an API key and no bearer token — the `service` scheme's
   * credential. `export` names `user` first, so this caller has to reach the
   * second requirement to be served at all.
   */
  readonly serviceClientFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<OrderApiClient>;
  /**
   * A supertest agent bound to the probe server — the one HTTP surface here with
   * no contract for the typed client to speak.
   */
  readonly probesFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<TestAgent>;
  /**
   * The origin string `supertest` takes directly, for a given served app — the
   * fragment answerer has no typed client, unlike the oRPC one `clientFor` gives.
   */
  readonly originFor: <E>(app: RunningApp<E, HttpInfo>) => Promise<string>;
  /**
   * The real root, served, as the origin string `supertest` takes directly — for
   * a spec about statuses and headers rather than payloads.
   */
  readonly origin: string;
  /** The real composition root. */
  readonly api: typeof OrderApi;
  /** The same two slices over stub persistence, with one customer registered. */
  readonly stubbed: ReturnType<typeof stubbedApi>;
  readonly unmodelled: ReturnType<typeof unmodelledApi>;
  readonly gate: ReturnType<typeof gatedApi>;
  /** The real root's composition, plus everything its logger wrote. */
  readonly recording: ReturnType<typeof recordingApi>;
  /** The real root over a customers repository that counts its reads. */
  readonly counting: ReturnType<typeof countingCustomers>;
};

/** The port comes back from `Serving.info`, the kernel's own channel for it. */
const originOf = async <E>(app: RunningApp<E, HttpInfo>): Promise<string> =>
  `http://127.0.0.1:${await portOf(app)}`;

export const it = test.extend<ApiFixtures>({
  // `LOG_LEVEL: "fatal"` keeps the real `OrderApi`, whose sink is the production
  // `jsonSink()` on stdout, out of the runner's own output. The roots a spec
  // reads back pin their level instead.
  boot: bootFixture({
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      LOG_LEVEL: "fatal",
      // A spec run stands up no collector, so the SDK is disabled through its
      // own switch and the ports still resolve to noop instruments.
      OTEL_SDK_DISABLED: "true",
      DATABASE_URL: inject("__ORDERS_DATABASE_URL__"),
      // The shared Redis, reached under a tenant of its own, so the cache needs
      // no more cleanup than the database does.
      REDIS_URL: inject("__TESTCONTAINERS_REDIS_URL__"),
    },
  }),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tenant: async ({}, use) => {
    await use(uuidv7());
  },

  serve: async ({ boot }, use) => {
    await use((module, options) => boot(module, options));
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
      return request(`http://127.0.0.1:${port}`);
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  originFor: async ({}, use) => {
    await use(originOf);
  },

  origin: async ({ serve }, use) => {
    await use(await originOf(serve(OrderApi)));
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

  // oxlint-disable-next-line no-empty-pattern -- see above
  counting: async ({}, use) => {
    await use(countingCustomers());
  },
});
