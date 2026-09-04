---
title: Open a per-request scope
description: Bind a module on the runtime's own unit option and let it fork the module around every unit it opens — built as the request opens, torn down as it closes, with no handler code managing the fork.
---

<!-- doctest: prelude
import { OrderApi } from "../../module.js";
-->

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
constructed and is torn down when the unit closes. A starter's own `unit`
option is that: the runtime forks the bound module itself, through
`UnitHost.fork`, at the moment it holds the unit's own input — and no handler
code ever calls `Module.forkScope` itself.

## Recipe

1. Write a `Module` whose providers are the per-unit services. Anything
   application-scoped they need arrives through their `inject` record.
2. Bind it on the starter's own `unit` option — `HttpModule`'s
   `unit: { anonymous }`, `AmqpModule`'s `unit: { message }`,
   `TemporalModule`'s `unit: { activity }` — or `@btravstack/testing`'s
   `testRuntime(name, { unit })`.
3. Export from the composition root whatever the unit module reads — the
   gate checks it at the call site, the same `UNSATISFIED DEPENDENCIES` one
   any other unmet need is refused on.

## Step 1 — the unit module

From `examples/order-api/src/request-scope.ts`, a span that logs how long the
request took:

```ts
import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";

export class RequestSpan extends Port("RequestSpan")<{
  readonly finish: () => void;
}> {}

export const RequestModule = Module("Request")({
  // The fork seam, declared: `Logger` comes from the application scope this
  // per-request module is forked from, never from inside it.
  needs: [Logger],
  provides: [
    Provider(RequestSpan)({
      inject: { logger: Logger },
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
    }),
  ],
  exports: [RequestSpan],
});
```

`Logger` is [the kernel's port](/reference/core/observability), provided at
application scope by the
[`observability()`](/reference/observability) the composition root imports:
the fork **reads** it from the parent, it does not rebuild it. `onStop` puts `Scope` in the module's needs, and only a fork
(or `Module.scoped`) opens one — so the teardown cannot be forgotten. Its type
is `Module<RequestSpan, never, Logger | Scope>`.

## Step 2 — bind it on the composition root

`RequestModule` is not passed to `start` or `runMain` any more — it rides
`HttpModule`'s own `unit` option, in `examples/order-api/src/module.ts`:

<!-- doctest: skip — quotes examples/order-api/src/module.ts, which the gate compiles in full -->

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  fragments: orderFragments,
  unit: { anonymous: RequestModule },
  imports: [OrdersSlice, CustomersSlice, observability(), otel()],
  exports: [Logger, Tracer, Meter],
});
```

`main.ts` does not change at all:

```ts
import { runMain } from "@btravstack/core";
import {
  createLogger,
  jsonSink,
  kernelEvents,
} from "@btravstack/observability";

import { OrderApi } from "./module.js";

await runMain(OrderApi, {
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

That is the whole of `examples/order-api/src/main.ts` — `onEvent` being the
separate matter of putting the kernel's own events in the same stream, covered
in [Log and correlate](/how-to/log-and-correlate). From here each **answerer**
forks `RequestModule` around **every unit it handles**: built as the request
opens, torn down as it closes, through `UnitHost.fork` inside its own
dispatch — not `host.run`, which stays the kernel's alone, counting the unit
towards the drain and closing the fork's scope once the unit's `Result`
settles.

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

`AnyUnitModule = Module<never, never, unknown>` is the bound every starter's
`unit` option constrains its own type parameter to — the middle, error,
channel is `never`. A unit is already inside the running application, so a
construction failure has no modeled startup channel to land in — **it rides
the unit's defect path**, which every runtime already answers:
`@btravstack/http-server` writes its `500` through the path each answerer
already had for any other defect — oRPC's own `INTERNAL_SERVER_ERROR` collapse,
`refuse(response, 500)` for htmx — before any procedure or fragment handler is
reached; a queue consumer dead-letters. Keep the unit
module's providers infallible — `sync`, `value`, `class`, or a `make`/`acquire`
whose `E` is `never`.

## The gate is the ordinary one

There is no separate marker for this any more — a bound `unit.anonymous`
module's own unmet needs simply **join `HttpModule`'s own `Needs` channel**,
so the gate that refuses them is `start`'s ordinary
`UNSATISFIED DEPENDENCIES`, never a fourth arm of the kernel's own marker (an
import's needs travel published in its type, and a bound `unit` module is no
different). A root that has its runtime and router but does not export
`Logger` is refused the same way any other unmet need is, ending on the port:

<!-- doctest: skip — quotes examples/order-api/src/needs-gate.test-d.ts, the real gate for the unit needs-propagation arm -->

```ts
const _unloggedUnit = HttpModule("WithUnitUnmet")({
  router: orderRouter,
  unit: { anonymous: HttpUnitModule },
  imports: [OrdersSlice, CustomersSlice, observability(), cache({ adapter: memoryCache() })],
  exports: [Logger],
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `HttpUnitDep`, which `HttpUnitModule` needs
const _withUnitUnmet = start(_unloggedUnit, options);
```

The port exists in that graph only if something provides it — `observability()`
provides `Logger`, but the bound unit module here needs a port nothing does,
and that is what the gate reads. That is why `OrderApi` exports `Logger`
next to `HttpRuntime`:
`HttpModule("OrderApi")({ router: orderRouter, unit: { anonymous: RequestModule },
imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
exports: [Logger] })`.

::: warning `RuntimeHost.ctx` is the application context
A unit-provided port exists only while a unit is open, and reaches a runtime
through `host.run`'s work callback alone. `host.ctx.get(RequestSpan)` at
runtime startup type-checks against nothing and would be a defect, so the
gate rejects a runtime whose `resolves` names a unit-only port: `UNSATISFIED
RUNTIME PORTS` is checked against the module's exports **only**, never a
fork's. Resolve at start what the application module itself exports.
:::

Two more consequences for anyone [writing a runtime](/how-to/write-a-runtime):
with a unit module the work runs only once `unit.fork(module, seed)` has
resolved — after an `await` when a unit provider is async — so a runtime that
subscribes to an event from inside its work must first check whether it
already fired
(`@btravstack/http-server` checks `response.closed` for exactly this). And a shipped
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
`unit.fork(module, seed)` is this call made by the runtime per unit, with the
parent being `host.ctx`, the application context — see
[Modules](/reference/di/modules) and [Entry points](/reference/di/entry-points).

## See also

- [The Runtime contract](/reference/core/runtime) — `UnitHost.fork` and the
  seam a runtime opens a per-unit scope through.
- [start and StartOptions](/reference/core/start) — the module gate, now that
  a per-unit scope is no longer one of its options.
- [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit) — what `currentUnit()` gives a teardown log line.
- [Log and correlate](/how-to/log-and-correlate) — the `Logger` this fork reads, and the trace id it stamps.
- [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) — the composition root this scope rides on.
- [Order API (HTTP)](/examples/order-api) — the example.
