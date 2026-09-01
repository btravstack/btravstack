---
title: Write a runtime
description: Hand-roll a Runtime for a transport the stack does not ship, declare its port over RuntimePort, and honour the contracts the kernel cannot check.
---

<!-- doctest: prelude
import { Module, Port, Provider, type AnyPort } from "@btravstack/di";
import { Ok, OkAsync, type AsyncResult } from "unthrown";
import {
  RuntimePort,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/core";
class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}
const AppModule = Module("App")({
  provides: [
    Provider(Greeter)({
      inject: {},
      value: { greet: (name: string) => `hello, ${name}` },
    }),
  ],
  exports: [Greeter],
});
-->

# Write a runtime

> **How-to.** Build a runtime for a transport `@btravstack/http-server`,
> `@btravstack/temporal-worker` and `@btravstack/amqp-worker` do not cover, and plug it into
> `start`. For _why_ the kernel owns the unit and never the outcome, see
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing); for the
> types, see [The Runtime contract](/reference/core/runtime).

A runtime owns the transport and nothing else. It is a **service the module
provides** on a port declared over `RuntimePort`, so it is built by di like
everything else and `start` finds it in the module's exports. The one below is a
timer, so the recipe stays self-contained.

## Step 1 — declare the port

```ts
import { RuntimePort, type Runtime } from "@btravstack/core";

class Ticker extends RuntimePort<Runtime<typeof Greeter>> {}
```

`RuntimePort` is `Port("Runtime")` left generic: every runtime port shares one
id at runtime — a process boots exactly one — while each carries its own
`Resolves` and `Info` in the type. `Runtime<typeof Greeter>` says this runtime
resolves `Greeter` from the application context; `start` refuses, at compile
time, a module that exports the port without exporting `Greeter`.

## Step 2 — implement `Runtime`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Runtime<Resolves extends AnyPort = never, Info = never> = {
  readonly name: string;
  readonly resolves: readonly Resolves[];
  readonly start: (
    host: RuntimeHost<Resolves>,
  ) => AsyncResult<Serving<Info>, RuntimeStartFailed>;
};
```

`start` receives a **host**, not a bare `Context`: `host.ctx` is the
application context, `host.run` is the kernel's `RunUnit`. Every piece of work
goes through `run` — that is what counts it towards the drain and hands it an
`AbortSignal`. It returns a `Serving`, whose `drain(signal)` means "stop
accepting" and `stop()` means "tear the transport down".

```ts
import { Ok, OkAsync } from "unthrown";
import type { Runtime, Serving } from "@btravstack/core";

const ticker: Runtime<typeof Greeter> = {
  name: "ticker",
  resolves: [Greeter],
  start: (host) => {
    const timer = setInterval(() => {
      // Every piece of work goes through `host.run`: that is what makes it
      // count towards the drain, and what gives it an `AbortSignal`.
      //
      // The unit's `Result` is the runtime's to map — the kernel hands it back
      // and stays out of it. A timer has nowhere to return one, so it observes
      // it instead; dropping it would hide the work's `Err` *and* a `Defect`.
      void host
        .run({ kind: "tick", id: `${Date.now()}` }, (ctx, signal) =>
          signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
        )
        .tapFailure((failure) => {
          process.stderr.write(`${JSON.stringify({ tick: failure.tag })}\n`);
        });
    }, 1_000);

    const serving: Serving = {
      // Stop accepting new work. In-flight units are the kernel's business.
      drain: () => {
        clearInterval(timer);
        return OkAsync();
      },
      stop: () => OkAsync(),
    };

    return OkAsync(serving);
  },
};
```

`drain` returns `void`, not a report: only the kernel can see the unit
registry, so the kernel owns the accounting. The `AbortSignal` it receives
fires when the kernel's deadline passes — a runtime never does arithmetic on
time. If the work your `drain` awaits settles on **somebody else's** clock —
Temporal's `shutdownForceTime`, a broker library's `close()` — it cannot
honour that signal on its own, and `releasedBy` is the primitive for it:

<!-- doctest: skip — an object-property excerpt, not a statement: the compiled form is `@btravstack/amqp-worker`'s and `@btravstack/temporal-worker`'s own `drain`, which this fence quotes -->

```ts
drain: (signal) => releasedBy(signal, running);
```

See [`releasedBy`](/reference/core/runtime#releasedby) for what the dropped
branch costs. `Serving.info` is optional and typed by `Info`; a runtime that binds an
ephemeral port publishes `{ port }` there and the caller reads it back through
`app.runtimeInfo()`.

A transport that can fail to come up answers with `RuntimeStartFailed`, the one
error the kernel mints, named after your runtime:

```ts
import {
  RuntimeStartFailed,
  type Runtime,
  type Serving,
} from "@btravstack/core";
import { Err, Ok, OkAsync, fromExecutor, fromSafePromise } from "unthrown";
import { createServer } from "node:http";

type TcpInfo = { readonly port: number };

const tcpish: Runtime<typeof Greeter, TcpInfo> = {
  name: "tcpish",
  resolves: [Greeter],
  start: () =>
    fromExecutor<Serving<TcpInfo>, RuntimeStartFailed>((settle) => {
      const server = createServer();
      // A port in use is the kernel's one error: `RuntimeStartFailed`, named after this runtime.
      server.once("error", (cause) =>
        settle(Err(new RuntimeStartFailed({ runtime: "tcpish", cause }))),
      );
      server.listen(0, () => {
        const address = server.address();
        const port =
          typeof address === "object" && address !== null ? address.port : 0;
        settle(
          Ok({
            drain: () => OkAsync(),
            stop: () =>
              fromSafePromise(
                new Promise<void>((done) => server.close(() => done())),
              ),
            // Whatever the runtime actually bound — read back through `app.runtimeInfo()`.
            info: { port },
          }),
        );
      });
    }),
};
```

## Step 3 — provide it on the port, export the port

```ts
import { Module, Provider } from "@btravstack/di";
import { runMain } from "@btravstack/core";

const TickerApp = Module("TickerApp")({
  imports: [AppModule],
  provides: [Provider(Ticker)({ inject: {}, value: ticker })],
  exports: [Greeter, Ticker],
});

await runMain(TickerApp);
```

The composition root is what differs between an `api`, a `worker` and a
`consumer` process; the application module is the same in all three. Drop
`Ticker` from `exports` and `runMain` refuses the module against
`"NO RUNTIME — the module exports no port declared over RuntimePort"`; drop
`Greeter` and it refuses it against
`"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.
Either way the sentence is the error's **last** line; the first names the two
`Module<…>` types.

## Honour the three contracts the kernel cannot check

Building the first real runtime on this contract hit every one of these, and
all three are silent when broken.

**1. Flush the response inside the unit.** A unit is closed the instant its
`Result` settles; an idle registry is the kernel's permission to call
`Serving.stop()`. A runtime that resolves the unit and _then_ writes to its
client is racing `stop()` tearing the transport down — a small body usually
wins, an 8 MB one loses (`UND_ERR_SOCKET: other side closed`). A unit is
"compute the answer **and get it out of the process**".

```ts
const serveOne = (
  host: RuntimeHost<typeof Greeter>,
  meta: UnitMeta,
  send: (body: string) => Promise<void>,
) =>
  // Flushed inside the work callback. Sending after `await host.run(...)`
  // returns is the race: the unit is already closed by then.
  host.run(meta, async (ctx, signal) => {
    const body = signal.aborted ? "" : ctx.get(Greeter).greet("world");
    await send(body);
    return Ok(body);
  });
```

::: tip If your work callback is someone else's `next()`
A middleware-shaped runtime opens the unit around a call it does not own the
arguments of, so the `signal` parameter above has nowhere to go — the work
callback _is_ the library's `next()`. The same signal is on the ambient record
as `currentUnit()?.signal`, which is how `@btravstack/temporal-worker` and
`@btravstack/amqp-worker` let an activity or a handler honour the deadline without an
injected context the transport's contract does not type. Pass it as a
parameter when you can, as `@btravstack/http-server` does; read it off the record
when you cannot.
:::

**2. `UnitMeta.id` is unique per unit, or you supply a `traceId`.** `traceId`
defaults to `id`, so passing a _category_ — a route template like
`"POST /orders"` — gives every request the same trace id and silently defeats
the ambient record. A route template is a `kind`. Mint the id, and adopt an
inbound correlation id only when it is non-blank (`""` is not nullish, so it
would win over the default):

```ts
const metaFor = (inboundTraceId: string | undefined): UnitMeta => ({
  kind: "tick",
  id: crypto.randomUUID(),
  ...(inboundTraceId === undefined ? {} : { traceId: inboundTraceId }),
});
```

**3. `host.ctx` is the application context, and unit work is not synchronous
with `host.run`.** Both follow from `StartOptions.unit`. A port the unit
module provides exists only while a unit is open and reaches you through
`run`'s work callback alone — resolve at `start` only what the application
module itself exports. And with a unit module the work runs only once the fork
is built, after an `await` when a unit provider is async: a runtime that
subscribes to an event from inside its work (a response's `'close'`) must first
check whether it already fired, or a client that hung up during a slow
per-request acquire leaves the unit open for the process lifetime.
`@btravstack/http-server` checks `response.closed` for exactly this.

## Ship it like a starter

The three shipped runtimes go one step further and take what the application
supplies — a router, activities, handlers — as a **port their runtime provider
depends on**, so their `resolves` is `never` and `host.ctx` goes unread. Do the
same once your runtime has application-specific inputs: a port's service type
is fixed at declaration, so a runtime with `resolves: [OrderRouter]` cannot ship
its port; a provider that depends on `OrderRouter` can. See
[Starters](/explanation/starters).

## See also

- [The Runtime contract](/reference/core/runtime) — `Runtime`, `RuntimeHost`,
  `RunUnit`, `Serving`, `RuntimeStartFailed`, complete.
- [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit) —
  what the `traceId` you supply is for.
- [Test an application](/how-to/test-an-application) — `testRuntime`, the
  smallest complete runtime, and how to drive yours under `bootFixture`.
