---
title: Open a per-request scope
description: Pass a module as StartOptions.unit and let the kernel fork it around every unit — built as the request opens, torn down as it closes, with no handler code managing the fork.
---

# Open a per-request scope

> **How-to.** Give a service the lifetime of one request, job or delivery,
> layered over the application scope the kernel opened once. For the option's
> full contract, see [start and StartOptions](/reference/core/start); for
> _why_ a scope is forked rather than reopened, see
> [Scopes and resource safety](/explanation/scopes-and-resources).

The application scope is opened once, by the kernel, and holds the database.
Reopening it per request would give every request its own empty database. What
you want is a **short-lived scope forked over the one already built** — a
per-request span, transaction or tenant context that reads what the parent
constructed and is torn down when the unit closes. `StartOptions.unit` is
that, and no handler ever calls `Module.forkScope` itself.

## Recipe

1. Write a `Module` whose providers are the per-unit services. Anything
   application-scoped they need arrives through their deps.
2. Pass it as `unit` to `start`, `runMain`, or `@btravstack/testing`'s `boot`.
3. Export from the composition root whatever the unit module reads — the
   gate checks it at the call site.

## Step 1 — the unit module

From `examples/order-api/src/request-scope.ts`, a span that logs how long the
request took:

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { Logger } from "@btravstack/observability";

export class RequestSpan extends Port("RequestSpan")<{
  readonly finish: () => void;
}> {}

export const RequestModule = Module("Request")({
  provides: [
    Provider(RequestSpan)(
      { logger: Logger },
      {
        sync: ({ logger }) => {
          const startedAt = Date.now();
          return {
            finish: () =>
              logger.info("request finished", {
                durationMs: Date.now() - startedAt,
              }),
          };
        },
        onStop: (span) => span.finish(),
      },
    ),
  ],
  exports: [RequestSpan],
});
```

`Logger` is [`@btravstack/observability`](/reference/observability)'s port,
provided at application scope by the `observability()` the composition root
imports: the fork **reads** it from the parent, it does not rebuild it. `onStop` puts `Scope` in the module's needs, and only a fork
(or `Module.scoped`) opens one — so the teardown cannot be forgotten. Its type
is `Module<RequestSpan, never, Logger | Scope>`.

## Step 2 — hand it to the kernel

```ts
import { runMain } from "@btravstack/core";
import {
  createLogger,
  jsonSink,
  kernelEvents,
} from "@btravstack/observability";

import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

That is the whole of `examples/order-api/src/main.ts` — `onEvent` being the
separate matter of putting the kernel's own events in the same stream, covered
in [Log and correlate](/how-to/log-and-correlate). From here the kernel
forks `RequestModule` around **every unit**: built as the unit opens, torn down
as it closes, inside `registry.run` — so the unit is not counted closed until
the fork is, and a drain waits for the teardown too.

## What the fork gives you

- **Teardown runs inside the unit's ambient record.** `RequestSpan.finish`
  runs while `currentUnit()` still answers, which is what gives its log line
  the request's own `traceId`. Pinned by `unit-module.spec.ts`: build and
  `onStop` observe the same unit.
- **The parent is built once.** Two requests build the span twice and the
  `Logger` once; the fork seeds the parent's services rather than
  reconstructing them.
- **A failing finaliser is an event, not an exit-report entry.** It is emitted
  as a `teardownError` event under the provider's port and kept off
  `ExitReport.teardownErrors`, which is the application scope's — a per-unit
  finaliser failing on every request would otherwise grow it without bound.

## The error channel is `never`

`unit` is `Module<UnitX, never, UnitNeeds>`. A unit is already inside the
running application, so a construction failure has no modeled startup channel
to land in — **it rides the unit's defect path**, which every runtime already
answers: `@btravstack/http` writes its `500` from the unit's `recoverDefect`,
before any procedure is reached; a queue consumer dead-letters. Keep the unit
module's providers infallible — `sync`, `value`, `class`, or a `make`/`acquire`
whose `E` is `never`.

## The gate has an arm for it

`start`'s phantom marker checks the fork's direction at the call site: the
unit module's needs must be covered by the module's **exports**, `Scope` or
`Env`. A root that has its runtime and router but does not export `Logger` is
refused against
`"UNSATISFIED UNIT NEEDS — the unit module needs a port the module does not export"`,
the last line of the error:

```ts
const UnloggedApi = Module("UnloggedApi")({
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability(),
    http(),
  ],
  provides: [orderRouter],
  exports: [HttpRuntime],
});

// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
```

The port exists in that graph — `observability()` provides it — but exporting
is what the gate reads, and `UnloggedApi` does not. That is why `OrderApi`
exports `Logger` next to `HttpRuntime`:
`HttpModule("OrderApi")({ router: orderRouter, imports: [OrderApplicationModule,
OrderPersistenceModule, observability()], exports: [Logger] })`.

::: warning `RuntimeHost.ctx` is the application context
A unit-provided port exists only while a unit is open, and reaches a runtime
through `host.run`'s work callback alone. `host.ctx.get(RequestSpan)` at
runtime startup type-checks against nothing and would be a defect, so the
gate rejects a runtime whose `needs` name a unit-only port: `UNSATISFIED
RUNTIME NEEDS` is checked against the module's exports **only**, never the
unit's. Resolve at start what the application module itself exports.
:::

Two more consequences for anyone [writing a runtime](/how-to/write-a-runtime):
with a unit module the work runs only once the fork is built — after an
`await` when a unit provider is async — so a runtime that subscribes to an
event from inside its work must first check whether it already fired
(`@btravstack/http` checks `response.closed` for exactly this). And a shipped
runtime does not read `ctx` at all: what a handler needs, its provider
declared.

## The raw form: `Module.forkScope`

Outside the kernel — a test, a script, a runtime of your own — the same fork
is one call on di. `Module.forkScope(parent, module, use)` layers `module`
over an already-built `Context`, runs `use` with the forked context, and tears
the fork down on every path:

```ts
import { Module, type Context } from "@btravstack/di";
import { OkAsync } from "unthrown";

declare const parent: Context<Logger>;

const handled = Module.forkScope(parent, RequestModule, (ctx) => {
  ctx.get(RequestSpan);
  return OkAsync("handled");
});
```

It carries di's own `UNSATISFIED DEPENDENCIES` gate on the parent's exports.
`StartOptions.unit` is this call made by the kernel per unit, with the parent
being the application context — see [Modules](/reference/di/modules) and
[Entry points](/reference/di/entry-points).

## See also

- [start and StartOptions](/reference/core/start) — the `unit` option and the three gate arms.
- [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit) — what `currentUnit()` gives a teardown log line.
- [Log and correlate](/how-to/log-and-correlate) — the `Logger` this fork reads, and the trace id it stamps.
- [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) — the composition root this scope rides on.
- [Order API (HTTP)](/examples/order-api) — the example.
