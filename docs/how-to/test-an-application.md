---
title: Test an application
description: Boot a module in a vitest fixture with bootFixture, reach a running service with tapped, drive the drain on a fake clock, and test through the real starters on an ephemeral port.
---

# Test an application

> **How-to.** Boot a module in a test, drive its lifecycle deterministically,
> and assert on what the kernel reports. For _why_ the harness is shaped this
> way, see [Nothing throws](/explanation/nothing-throws) and
> [Draining, in three beats](/explanation/draining-in-three-beats); for the
> full surface, see [@btravstack/testing](/reference/testing).

Everything you need is in `@btravstack/testing`, a dev dependency
(`pnpm add -D @btravstack/testing`) that peers on `@btravstack/core`,
`@btravstack/config`, `@btravstack/di` and `unthrown` — the copies your
application already holds. Four tools: `bootFixture` boots and stops inside a
vitest fixture, `tapped` reaches a service of a running graph (its lines come
back through `observability({ sink })` instead), `testRuntime` stands in for a
transport, `createFakeClock` moves time when you say so.

## Boot in a fixture with `bootFixture`

The recipe is one fixture module per package, exporting the `it` every spec
imports:

```ts
// src/test-fixtures.ts
import { bootFixture, type Boot } from "@btravstack/testing";
import { test } from "vitest";

export const it = test.extend<{ boot: Boot }>({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
});
```

`boot` is `start` with a test's defaults baked in — `signals: false` always,
`probes: false`, `preDrainDelayMs: 0`, a silent `onEvent` — and **every
application it starts is stopped when the test ends**, on every exit path.
A call's own options win over the fixture's (`boot(module, { probes: { port:
0 } })` binds an ephemeral probe port), and `unit` goes on the call, because a
unit module is the composition's choice, not the fixture's:

```ts
// src/api.spec.ts
import { describe, expect } from "vitest";
import { it } from "./test-fixtures.js";

describe("order-api", () => {
  it("answers a real oRPC call on an ephemeral port", async ({ boot }) => {
    // GIVEN the real composition root, bound to a loopback port the OS picks
    const app = boot(OrderApi, { unit: RequestModule });
    const info = (await app.runtimeInfo()).get();
    const client = createOrderApiClient(
      `http://127.0.0.1:${info?.port}`,
      "/rpc",
      {
        authorization: `Bearer ${tenantId}:u-1`,
      },
    );

    // WHEN a call goes over the wire
    // THEN it reached the use case behind the transport
    await expect(client.orders.place({ id: "o-1", quantity: 2 })).toBeOkWith({
      id: "o-1",
      quantity: 2,
    });
  });
});
```

The credentials are not optional: the contract marks its `orders` fragment
[`authenticated`](/reference/contract), so the same call without an
`authorization` header is refused before any procedure runs — and
`UNAUTHORIZED` is not an error the contract declares, so it arrives as a
`Defect` rather than in `errCases`. What the token establishes here is the
tenant; the example's fixtures wrap this up as `clientFor`, which is why every
spec below takes that fixture rather than building a client by hand. See
[Protect a procedure](/how-to/protect-a-procedure).

`runtimeInfo()` is whatever the runtime published on `Serving.info` — the
HTTP starter publishes `{ port }` — and `probePort()` the probe port that
bound. Both carry `E = never`, so `.get()` is the whole read. The teardown
is `stop()`, then `exited` is examined, and a **`Defect`**
there fails the test even if the test never looked at `exited`; a modeled
`Err` passes through, since a startup failure is an outcome you may be
asserting.

## Reach a running service with `tapped`

`start` hands the application context to the runtime alone, so a spec has no
`ctx.get` to reach the very `OrderRepository` the running graph writes
through. `tapped(module,
[Port, …])` composes one more provider around the module and hands back what
it was built with; boot `tap.module` in place of the module and read
`tap.services()` afterwards:

```ts
it("broadcasts every committed write, end to end", async ({ serve }) => {
  // GIVEN the real graph, tapped on the writer the spec places orders through
  const tap = tapped(OrderAmqpWorker, [PlaceOrder, OrderRepository, Outbox]);
  await serve(tap.module);
  const [placeOrder] = tap.services();

  // WHEN an order is placed — one ordinary write, no publish in sight
  // THEN it is the very instance the relay sweeps, so the fact crosses the
  // outbox, the broker and the queue
  await expect(placeOrder.execute("o-1", 2)).toBeOkWith(
    expect.objectContaining({ id: "o-1" }),
  );
});
```

A port the module does not export is refused at the call site by the
[tap gate](/reference/testing#the-tap-gate-an-arity-error), and `services()`
throws if read before the graph is built — a bug in the test, kept loud
rather than answered with an `undefined`.

## Read a running graph's log lines with a sink

A tap is the wrong tool for this, and `examples/order-api` uses none:
`@btravstack/observability`'s `observability({ sink })` is the seam. The sink
is a value the composition takes, so what a spec gets back is the `Line`
itself — `unit.traceId` as a field rather than a prefix parsed out of a
string. Compose the root's own shape with a recording sink, and boot that:

```ts
const lines: Line[] = [];

const recordingApi = HttpModule("RecordingApi")({
  router: orderRouter,
  // The same authenticator as the real root: the contract marks `orders`, so
  // every composition serving that router owes one.
  authenticator: bearerAuthenticator,
  imports: [
    OrdersSlice,
    CustomersSlice,
    // Pinned rather than bound: the fixture's `LOG_LEVEL` silences the real
    // root, and this root exists to be read.
    observability({ sink: (line) => lines.push(line), level: "trace" }),
  ],
  exports: [Logger],
});

it("runs each call in its own unit, with its own trace id", async ({
  serve,
  clientFor,
}) => {
  // GIVEN the real graph's composition, recording every line its logger writes
  const client = await clientFor(serve(recordingApi));

  // WHEN two calls are served — chained, so neither `Result` is dropped
  const served = await client.orders
    .place({ id: "o-1", quantity: 1 })
    .flatMap(() => client.orders.place({ id: "o-2", quantity: 1 }));

  // THEN four lines, two distinct trace ids, none written outside a unit
  const traced = served.map(() => ({
    lines: lines.length,
    distinct: new Set(lines.map((line) => line.unit?.traceId)).size,
    outOfUnit: lines.filter((line) => line.unit === undefined).length,
  }));

  expect(traced).toBeOkWith({ lines: 4, distinct: 2, outOfUnit: 0 });
});
```

A parallel root rather than `OrderApi` itself, because nothing can be layered
over a graph that already provides `Logger`. Give the fixture's own `env` a
`LOG_LEVEL: "fatal"` so the real root — whose sink is the production
`jsonSink()` on stdout — does not write into the runner's output. See
[Log and correlate](/how-to/log-and-correlate).

## Kernel-level: `testRuntime` and `createFakeClock`

To test the lifecycle itself — a drain, an abandonment, an exit report —
you want no transport and no real clock. `testRuntime(name?)` is an in-memory
`Runtime<never, TestRuntimeInfo>` whose `module` provides it on
`TestRuntimePort`, so a test composition gets a runtime the way a real one
does: import the module, export the port. `createFakeClock()` passed as
`clock` makes the pre-drain delay and drain deadline elapse only on
`advance(ms)`.

| Member           | What it gives you                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `module`         | a `Module<TestRuntimePort, never, never>` providing this runtime                              |
| `untilStarted()` | resolves the first time the kernel calls `start` — `AsyncResult<void, never>`                 |
| `started()`      | whether `start` has been called                                                               |
| `accepting()`    | `false` once `drain` or `stop` has been called — _when_ the kernel told it to stop            |
| `serving()`      | the `Serving` it handed the kernel (throws if not started — a bug in the test)                |
| `submit<T, E>()` | opens a unit and returns `{ settle, result, signal }`, so you can hold it open across a drain |

```ts
import { Module, Port, Provider } from "@btravstack/di";
import {
  TestRuntimePort,
  bootFixture,
  createFakeClock,
  testRuntime,
  type Boot,
} from "@btravstack/testing";
import { Ok } from "unthrown";
import { describe, expect, test } from "vitest";

const it = test.extend<{ boot: Boot }>({ boot: bootFixture() });

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

const AppModule = Module("App")({
  provides: [
    Provider(Greeter)({ value: { greet: (name: string) => `hello, ${name}` } }),
  ],
  exports: [Greeter],
});

describe("draining", () => {
  it("lets an in-flight unit finish inside the drain window", async ({
    boot,
  }) => {
    // GIVEN the application composed with the in-memory runtime, on a fake clock
    const clock = createFakeClock();
    const runtime = testRuntime();
    const TestApp = Module("TestApp")({
      imports: [AppModule, runtime.module],
      exports: [TestRuntimePort],
    });

    const app = boot(TestApp, { clock, preDrainDelayMs: 5_000 });
    await runtime.untilStarted();
    const unit = runtime.submit<string>();

    // WHEN a drain is requested and the pre-drain delay elapses
    app.requestDrain();
    await clock.advance(5_000);

    unit.settle(Ok("done"));
    const report = await app.exited;

    // THEN the unit is counted completed, not abandoned
    expect(report).toBeOkWith(
      expect.objectContaining({
        drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
      }),
    );
  });
});
```

To prove abandonment instead, never `settle` the unit and advance past the
deadline too (`await clock.advance(20_000)`): the report reads `abandoned: 1`,
because `testRuntime` **ignores the drain signal deliberately** and leaves the
unit to the kernel.

`toBeOkWith`, `toBeErrWith`, `toBeErrTagged` and `toBeDefectWith` come from
[`@unthrown/vitest`](https://github.com/btravstack/unthrown/tree/main/packages/vitest);
register them once through `setupFiles` and add
`import type {} from "@unthrown/vitest";` to a `vitest.d.ts` so they type.

## How the examples do it

The examples do not fake the transport: they boot the real composition root
on an ephemeral loopback port and talk to it with a typed client.
`examples/order-api/src/test-fixtures.ts` starts from `bootFixture` and layers
the example's own fixtures on top of `boot`:

```ts
export const it = test.extend<ApiFixtures>({
  boot: bootFixture({
    env: { PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "fatal" },
  }),

  serve: async ({ boot }, use) => {
    await use((module, options) =>
      boot(module, { unit: RequestModule, ...options }),
    );
  },
  // …clientFor, probesFor, statusOf, api, unmodelled, gate, recording
});
```

`serve` is `boot` with `RequestModule` forked around every request, so its
shutdown is still the fixture's; `clientFor` builds the oRPC client from
`runtimeInfo()` **and gives it credentials for this test's tenant**
(`Bearer ${tenant}:u-1`), since the contract marks the `orders` fragment and an
anonymous call to it never reaches a use case; and `recording` is the real
root's composition with a recording sink in place of stdout:

```ts
const recordingApi = () => {
  const recorder = recorderOf();
  return {
    api: HttpModule("RecordingApi")({
      router: orderRouter,
      authenticator: bearerAuthenticator,
      imports: [
        OrdersSlice,
        CustomersSlice,
        observability({ sink: recorder.sink, level: "trace" }),
      ],
      exports: [Logger],
    }),
    lines: recorder.lines,
  };
};
```

The tenant a handler serves is **not** an input field any more: the `orders`
handlers read `context.principal.tenantId`, the value the authenticator
resolved from the request's headers, and the marked fragment's inputs declare
no tenant at all. So a spec's tenant reaches the server through the **token**
`clientFor` mints and nowhere else. The unmarked `customers` fragment still
names its tenant on the input, which is why its calls still pass one.

`api.spec.ts` then swaps the repository for a stub that holds a request open
to prove `completed: 1` and `abandoned: 1` against the real HTTP runtime (see
[Swap an adapter for tests](/how-to/swap-an-adapter)). The other two examples
follow the same shape — `boot: bootFixture()`, a `serve` that adds the
transport's own environment, `tapped` over the **services** the specs assert
through and `observability({ sink })` for the lines — and pay a fixture cost,
stated in their READMEs: they need a **Docker daemon**.

## Isolate by the boundary, not by the server

Every suite that needs a broker, a workflow platform or a database shares
**one** of each across the whole repository, and isolates itself by the
boundary that system already has:

| System     | What a test gets     | Minted by                                   |
| ---------- | -------------------- | ------------------------------------------- |
| RabbitMQ   | a vhost per test     | `@amqp-contract/testing`'s `it` extension   |
| Temporal   | a namespace per file | `@btravstack/internal-test-infra/namespace` |
| PostgreSQL | a tenant per test    | the workspace's own fixture, a UUID         |

Starting a server per workspace instead is what made `pnpm test` intermittently
red at turbo's default concurrency, and it bought an isolation these boundaries
already gave for nothing.

The consequence worth planning for: **nothing cleans up after a test**. No
truncate, no drop, no purge — a test that needed one would be a test sharing a
namespace it should have minted. One migration runs for the whole gate, and
the tests that share that schema never see each other's rows.

Reading a tenant back needs nothing at all, because the example application
names it on its ports rather than reading it from ambient context:

```ts
export const it = test.extend<{ tenant: string }>({
  // oxlint-disable-next-line no-empty-pattern -- depends on no other fixture
  tenant: async ({}, use) => {
    await use(`t-${randomUUID()}`);
  },
});

it("reads back only its own tenant's order", async ({
  tenant,
  repository,
  anOrder,
}) => {
  // GIVEN an order saved under this test's tenant
  // WHEN it is read back
  const found = await repository
    .save(tenant, anOrder("o-1", 3))
    .flatMap(() => repository.find(tenant, "o-1"));

  // THEN the round trip is lossless, and scoped
  expect(found).toBeOkWith({ id: "o-1", quantity: 3 });
});
```

That is the whole fixture. See [Multi-tenancy is the application's, not the
framework's](/how-to/read-the-ambient-unit#multi-tenancy-is-the-application-s-not-the-framework-s)
for why the tenant is an argument rather than something the transport reads.

## Follow the repo's test conventions

The specs in `examples/` are read as advice, so they keep five rules; the last
two bind everywhere.

| Rule                                                                    | Why                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `describe` is the first statement                                       | helpers above it are invisible state a test silently depends on                                       |
| helpers are fixtures via `test.extend`, in a sibling `test-fixtures.ts` | what a test needs arrives through its parameter list; fixtures are lazy                               |
| teardown lives in the fixture, after `await use(...)`                   | it runs on every exit path, without a `try`/`finally` around the body                                 |
| every body carries `// GIVEN`, `// WHEN`, `// THEN`                     | setup is not read as the subject; a test that cannot split is testing two things                      |
| one deep `expect` per test, on one resource                             | `expect(r).toBeErr(); if (r.isErr()) {…}` goes green when the narrowing is false; a projection cannot |

`bootFixture` is what the second and third rules asked for: a callback
harness cannot be handed to `use()`, which is why every suite once hand-rolled
the same `start(...)` plus `stop(); expect(exited).toBeOk()` — now the
package's. Two resources means two tests. Waiting is not asserting:
synchronise on a state with `vi.waitUntil(() => app.phase() === "draining")`
and assert that state in the one `expect`.

## See also

- [@btravstack/testing](/reference/testing) — every member, with types.
- [Swap an adapter for tests](/how-to/swap-an-adapter) — compose a stub
  persistence module instead of overriding a provider.
- [Order API (HTTP)](/examples/order-api) — the spec and fixture files quoted
  above, in full.
