---
title: Test an application
description: Boot a module under test with withApp, drive the drain on a fake clock, and test through the real starters on an ephemeral port.
---

# Test an application

> **How-to.** Boot a module in a test, drive its lifecycle deterministically,
> and assert on what the kernel reports. For _why_ the harness is shaped this
> way, see [Nothing throws](/explanation/nothing-throws) and
> [Draining, in three beats](/explanation/draining-in-three-beats); for the
> full surface, see [Testing entry point](/reference/core/testing).

Everything you need is in `@btravstack/core/testing`, a second entry point kept
out of the main one so a production bundle never pulls the fakes in. Three
tools: `withApp` starts and stops, `testRuntime` stands in for a transport,
`createFakeClock` moves time when you say so.

## Boot, use, stop with `withApp`

`withApp(module, options, use)` starts the module, hands the `RunningApp` to
`use`, and stops it again whatever `use` does. Two options are **forced off**
whatever you pass: `signals` (process-wide handlers would fight across a test
file) and `probes` (a port would collide between tests). A test that needs the
real probe server calls `start` directly.

It **rethrows a `Defect`** on `exited`, so a shutdown that blew up fails the
test even when `use` never read `exited`; a modeled `Err` passes through, being
an outcome you may be asserting. A failure thrown by `use` (a failed `expect`)
is held while the application is stopped, then rethrown unchanged — it outranks
anything the shutdown says. Both `use` and `withApp` speak a bare `Promise`,
deliberately: an `AsyncResult` never rejects, so wrapping the test body would
turn a failing assertion into a defect you can forget to unwrap.

## Stand in for the transport with `testRuntime`

`testRuntime(name?)` is an in-memory `Runtime<never, TestRuntimeInfo>`. Its
`module` provides it on `TestRuntimePort`, so a test composition gets a runtime
the way a real one does: import the module, export the port.

| Member           | What it gives you                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `module`         | a `Module<TestRuntimePort, never, never>` providing this runtime                              |
| `untilStarted()` | resolves the first time the kernel calls `start` — `AsyncResult<void, never>`                 |
| `started()`      | whether `start` has been called                                                               |
| `accepting()`    | `false` once `drain` or `stop` has been called — _when_ the kernel told it to stop            |
| `serving()`      | the `Serving` it handed the kernel (throws if not started — a bug in the test)                |
| `submit<T, E>()` | opens a unit and returns `{ settle, result, signal }`, so you can hold it open across a drain |

It publishes `{ name }` on `Serving.info`, and it **ignores the drain
signal deliberately**: a unit you never `settle` stays open past the deadline,
which is what makes an abandonment test a test of the kernel, not the fake.

## Move time with `createFakeClock`

Pass `createFakeClock()` as `clock` and the pre-drain delay and drain deadline
elapse only on `advance(ms)`. Each `advance` brackets itself with a real
macrotask at both ends, so you can trigger a shutdown and advance in the very
next statement without racing the kernel arming its next sleep. A drain test
runs in milliseconds instead of twenty-five seconds.

```ts
import { Module, Port, Provider } from "@btravstack/di";
import {
  TestRuntimePort,
  createFakeClock,
  testRuntime,
  withApp,
} from "@btravstack/core/testing";
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
because `testRuntime` ignores the drain signal and leaves the unit to the
kernel.

`toBeOkWith`, `toBeErrWith`, `toBeErrTagged` and `toBeDefectWith` come from
[`@unthrown/vitest`](https://github.com/btravstack/unthrown/tree/main/packages/vitest);
register them once through `setupFiles` and add
`import type {} from "@unthrown/vitest";` to a `vitest.d.ts` so they type.

## Hand in an environment, read back what was bound

`start` takes `env` (a plain record — the `Env` port every config provider
reads) and `probes` (`{ port: 0 }` for an OS-chosen port, `false` for none).
Two deferred reads answer with what actually happened: `runtimeInfo()` is
whatever the runtime published on `Serving.info`, `probePort()` the probe port
that bound. Both carry `E = never`, so `.get()` is the read.

```ts
import { start } from "@btravstack/core";
import { testRuntime, TestRuntimePort } from "@btravstack/core/testing";

it("publishes what the runtime and the probe server bound", async () => {
  // GIVEN the application started directly, with an environment of its own
  const runtime = testRuntime("in-memory");
  const TestApp = Module("TestApp")({
    imports: [AppModule, runtime.module],
    exports: [TestRuntimePort],
  });
  const app = start(TestApp, {
    env: { PORT: "0" },
    probes: { port: 0 },
    signals: false,
  });

  // WHEN both deferred reads settle
  const published = {
    info: (await app.runtimeInfo()).get(),
    probePort: (await app.probePort()).get(),
  };
  app.stop();
  await expect(app.exited).toBeOk();

  // THEN the runtime's own info and an OS-chosen probe port came back
  expect(published).toEqual({
    info: { name: "in-memory" },
    probePort: expect.any(Number),
  });
});
```

## Test through the real starter

The examples do not fake the transport: they boot the real composition root
on an ephemeral loopback port and talk to it with a typed client.
`examples/order-api` starts `OrderApi` with `env: { PORT: "0", HOST: "127.0.0.1" }`
and reads the port back off `runtimeInfo()`:

```ts
import { start } from "@btravstack/core";
import { createOrderApiClient } from "./client.js";
import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

it("answers a real oRPC call on an ephemeral port", async () => {
  // GIVEN the real composition root, bound to a loopback port the OS picks
  const app = start(OrderApi, {
    env: { PORT: "0", HOST: "127.0.0.1" },
    unit: RequestModule,
    signals: false,
    probes: false,
    preDrainDelayMs: 0,
  });
  const info = (await app.runtimeInfo()).get();
  const client = createOrderApiClient(`http://127.0.0.1:${info?.port}`);

  // WHEN a call goes over the wire
  const placed = await client.orders.place({ id: "o-1", quantity: 2 });
  app.stop();
  await expect(app.exited).toBeOk();

  // THEN it reached the use case behind the transport
  expect(placed).toBeOkWith({ id: "o-1", quantity: 2 });
});
```

`examples/order-api/src/test-fixtures.ts` folds that into a `serve` fixture
whose teardown stops every app it started and asserts the exit was `Ok`;
`api.spec.ts` then swaps the repository for a stub that holds a request open
to prove `completed: 1` and `abandoned: 1` against the real HTTP runtime
(see [Swap an adapter for tests](/how-to/swap-an-adapter)).

The other two examples pay a fixture cost, stated in their READMEs:
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

Two resources means two tests. Waiting is not asserting: synchronise on a
state with `vi.waitUntil(() => app.phase() === "draining")` and assert that
state in the one `expect`.

## See also

- [Testing entry point](/reference/core/testing) — every member of
  `@btravstack/core/testing`, with types.
- [Swap an adapter for tests](/how-to/swap-an-adapter) — compose a stub
  persistence module instead of overriding a provider.
- [Order API (HTTP)](/examples/order-api) — the spec and fixture files quoted
  above, in full.
