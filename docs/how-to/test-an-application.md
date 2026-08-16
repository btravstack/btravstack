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
application already holds. Five tools: `bootFixture` boots and stops inside a
vitest fixture, `tapped` reaches a service of a running graph, `withApp`
starts and stops around a callback, `testRuntime` stands in for a transport,
`createFakeClock` moves time when you say so.

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
    const client = createOrderApiClient(`http://127.0.0.1:${info?.port}`);

    // WHEN a call goes over the wire
    // THEN it reached the use case behind the transport
    await expect(client.orders.place({ id: "o-1", quantity: 2 })).toBeOkWith({
      id: "o-1",
      quantity: 2,
    });
  });
});
```

`runtimeInfo()` is whatever the runtime published on `Serving.info` — the
HTTP starter publishes `{ port }` — and `probePort()` the probe port that
bound. Both carry `E = never`, so `.get()` is the whole read. The teardown
mirrors `withApp`: `stop()`, then `exited` is examined, and a **`Defect`**
there fails the test even if the test never looked at `exited`; a modeled
`Err` passes through, since a startup failure is an outcome you may be
asserting.

## Reach a running service with `tapped`

`start` hands the application context to the runtime alone, so a spec has no
`ctx.get` to reach the very `Logger` the use cases wrote to. `tapped(module,
[Port, …])` composes one more provider around the module and hands back what
it was built with; boot `tap.module` in place of the module and read
`tap.services()` afterwards:

```ts
it("logs each request under its own trace id", async ({ boot }) => {
  // GIVEN the real graph, tapped on the very Logger it holds
  const tap = tapped(OrderApi, [Logger]);
  const app = boot(tap.module, { unit: RequestModule });
  const info = (await app.runtimeInfo()).get();
  const client = createOrderApiClient(`http://127.0.0.1:${info?.port}`);

  // WHEN two calls are served
  const served = await client.orders
    .place({ id: "o-1", quantity: 1 })
    .flatMap(() => client.orders.place({ id: "o-2", quantity: 1 }));

  // THEN the lines carry two distinct trace ids
  const [logger] = tap.services();
  const traces = logger
    .lines()
    .map((line) => line.slice(0, line.indexOf("]") + 1));
  expect(served.map(() => new Set(traces).size)).toBeOkWith(2);
});
```

The gate refuses a port the module does not export (`NOT EXPORTED`, at the
call site), and `services()` throws if read before the graph is built — a
bug in the test, kept loud rather than answered with an `undefined`.

## A one-off with `withApp`

Outside a fixture module — a script, a single test that boots differently —
`withApp(module, options, use)` starts the module, hands the `RunningApp` to
`use`, and stops it again whatever `use` does. `signals` and `probes` are
forced off whatever you pass. It rethrows a `Defect` on `exited` and holds a
throw from `use` (a failed `expect`) until the application is stopped, then
rethrows it unchanged, so a shutdown defect can never mask the assertion that
failed. Both `use` and `withApp` speak a bare `Promise`, deliberately: an
`AsyncResult` never rejects, so wrapping the test body would turn a failing
assertion into a defect you can forget to unwrap.

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
  createFakeClock,
  testRuntime,
  withApp,
} from "@btravstack/testing";
import { Ok } from "unthrown";
import { describe, expect, it } from "vitest";

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
  it("lets an in-flight unit finish inside the drain window", async () => {
    // GIVEN the application composed with the in-memory runtime, on a fake clock
    const clock = createFakeClock();
    const runtime = testRuntime();
    const TestApp = Module("TestApp")({
      imports: [AppModule, runtime.module],
      exports: [TestRuntimePort],
    });

    const report = await withApp(TestApp, { clock }, async (app) => {
      await runtime.untilStarted();
      const unit = runtime.submit<string>();

      // WHEN a drain is requested and the pre-drain delay elapses
      app.requestDrain();
      await clock.advance(5_000);

      unit.settle(Ok("done"));
      return await app.exited;
    });

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
unit to the kernel. The same test reads the same under `boot(TestApp, {
clock })` with the fixture's teardown doing the stopping.

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
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),

  serve: async ({ boot }, use) => {
    await use((module, options) =>
      boot(module, { unit: RequestModule, ...options }),
    );
  },
  // …clientFor, probesFor, statusOf, api, unmodelled, gate, tapped
});
```

`serve` is `boot` with `RequestModule` forked around every request, so its
shutdown is still the fixture's; `clientFor` builds the oRPC client from
`runtimeInfo()`; and `tapped` is the example's tap on the real root:

```ts
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
```

`api.spec.ts` then swaps the repository for a stub that holds a request open
to prove `completed: 1` and `abandoned: 1` against the real HTTP runtime (see
[Swap an adapter for tests](/how-to/swap-an-adapter)). The other two examples
follow the same shape — `boot: bootFixture()`, a `serve` that adds the
transport's own environment, `tapped` over the services the specs assert
through — and pay a fixture cost, stated in their READMEs:
`order-temporal-worker` runs a real Worker against `@temporalio/testing`'s
**time-skipping test server**, a local binary downloaded once into
`.cache/temporal-test-server` (network on a cold cache only);
`order-amqp-worker` and `@btravstack/amqp` boot **one RabbitMQ container** per
vitest run through `@amqp-contract/testing`, so they need a Docker daemon.

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
