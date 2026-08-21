---
title: Log and correlate
description: Add @btravstack/observability, log structured attributes from a use case, read a line back, raise the level from the environment, swap in pino, and put the kernel's own events in the same stream.
---

# Log and correlate

> **How-to.** Get structured lines out of your application, each one stamped
> with the unit that wrote it, without threading a trace id through a single
> signature. For the full surface, see
> [`@btravstack/observability`](/reference/observability); for _why_ a trace id
> may be ambient and a repository may not, see
> [Ambient data, injected capabilities](/explanation/ambient-vs-context).

You want `logger.info("placing an order", { orderId, quantity })` in a use
case, and the resulting line to carry the request's trace id in production, in
a worker, and in a test — with nothing in the use case knowing any of that
happened. The recipe is one import.

## Recipe

1. `pnpm add @btravstack/observability` (its peers are the ones you already
   have: `@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
   `unthrown`).
2. Add `observability()` to the composition root's `imports`.
3. Depend on `Logger` from any provider that writes lines.
4. Export `Logger` if anything outside the root reads it — a
   `StartOptions.unit` module, a test.

```ts
import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { HttpModule } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";

export const OrderApi = HttpModule("OrderApi")({
  needs: [Env],
  router: orderRouter,
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
  exports: [Logger],
});
```

That is the whole of it. `LOG_LEVEL` is read inside the graph, the default
sink writes one JSON object per line on stdout, and every line written inside
a unit carries that unit's ids.

## Log from a use case

`Logger` is an ordinary port, so it arrives the ordinary way — named in the
provider's `deps` record, never from a global or an ambient read:

```ts
class PlaceOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;
  readonly #logger: ServiceOf<Logger>;

  constructor({
    repository,
    logger,
  }: {
    readonly repository: ServiceOf<OrderRepository>;
    readonly logger: ServiceOf<Logger>;
  }) {
    this.#repository = repository;
    this.#logger = logger;
  }

  execute(tenantId: TenantId, id: string, quantity: number) {
    this.#logger.info("placing an order", { tenantId, orderId: id, quantity });
    return placeOrder(id, quantity)
      .toAsync()
      .flatMap((order) => this.#repository.save(tenantId, order));
  }
}

export const placeOrderProvider = Provider(PlaceOrder)(
  { repository: OrderRepository, logger: Logger },
  { class: PlaceOrderInteractor },
);
```

The tenant is an **argument**, not something read back out of the ambient
record — `TenantId` is `examples/order-domain`'s brand, and a use case that
forgot it, or swapped it with the id beside it, does not compile. It is a
field on the line for the same reason `orderId` is: a fact worth grouping by,
written down where the call is.

**The message is a constant and the ids are fields.** That is what makes a
line groupable in the system that receives it: `message: "placing an order"`
finds every placement, `orderId: "0199a1e0-0000-7000-8000-000000000001"` finds one. A rendered sentence —
`` `placing order ${id}` `` — is neither.

Attributes are flat scalars (`string | number | boolean | undefined`), and a
failure has a channel of its own — the third argument of **every** method, so
a retryable failure can be a `warn` and still say why:

```ts
logger.warn(
  "publishing an outbox event failed, will retry",
  { eventId: event.id },
  cause,
);
```

Pass the failure as `cause`, never as an attribute: an `Error`'s `message` and
`stack` are non-enumerable, so `JSON.stringify` alone drops exactly the part
worth keeping. The sink is what normalises it.

For a set of attributes every line in a scope should carry, `with` returns a
**new** logger rather than mutating the one every caller shares:

```ts
const scoped = logger.with({ component: "outbox-relay" });
```

## Read a line

Nothing in the use case mentions correlation, and the line has it anyway —
`createLogger` reads [`currentUnit()`](/how-to/read-the-ambient-unit) on every
call, so one application-scope logger is correct for every request:

```json
{
  "tenantId": "0199a1e0-0000-7000-8000-0000000000ff",
  "orderId": "0199a1e0-0000-7000-8000-000000000001",
  "quantity": 2,
  "time": "2026-08-16T09:41:02.113Z",
  "level": "info",
  "message": "placing an order",
  "unitId": "0f2a…",
  "traceId": "b41e…"
}
```

`traceId` is the field to search on: `@btravstack/http` fills it from
`x-request-id`, `@btravstack/temporal` from the workflow id (stable across
retries) and `@btravstack/amqp` from the message id, so a line logged here
joins a trace that started outside the process. `unitId` is minted per unit and
always unique. Outside a unit — a startup line, a spec that boots no kernel —
neither field is on the line at all.

A caller's attribute can never overwrite `level`, `message`, `time` or the
correlation, whatever it is named.

## Raise the level

```sh
LOG_LEVEL=debug node dist/main.js
```

Six levels, in order: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.
Default `info`. A value outside the six is a **startup failure** — a
`ConfigInvalid` naming the variable and the set, reported as a `startFailed`
event and [exit code `78`](/reference/core/exit-codes), before a line is
written. A deployment that meant `debug` and typed `verbose` is told, rather
than quietly under-logged for a week.

To pin the level from code instead — a CLI, a test — pass it, and the
environment is not read for that field:

```ts
observability({ level: "debug" });
```

For a payload expensive enough to be worth not building, ask first:

```ts
if (logger.isEnabled("debug")) {
  logger.debug("payload", { body: JSON.stringify(payload) });
}
```

## Swap in pino

The default sink has no dependencies and does a `JSON.stringify` per line. If
that shows up in a profile, `pino` is an **optional** peer behind a subpath:

```sh
pnpm add pino
```

```ts
import pino from "pino";
import { observability } from "@btravstack/observability";
import { pinoSink } from "@btravstack/observability/pino";

observability({ sink: pinoSink(pino({ level: "trace" })) });
```

Configure pino at `trace`. **The level filter stays this package's** — a line
below `LOG_LEVEL` never reaches a sink — so there is one filter in the
process, and it is the one validated at startup. The attributes and the unit's
ids ride as pino fields; the cause goes over as `err`, which pino's own
serialiser renders with the stack.

## Put the kernel's events in the same stream

The kernel emits [nine lifecycle events](/reference/core/events) and its
default sink writes JSON to stderr — right for a process with no logger, wrong
for one with: two streams, two shapes, two sets of fields to search.
`kernelEvents` is the adapter between them:

```ts
import { runMain } from "@btravstack/core";
import {
  createLogger,
  jsonSink,
  kernelEvents,
} from "@btravstack/observability";

await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

`serving` now lands next to the request that was in flight when it did, and a
drain's numbers arrive as `inFlightAtStart` / `completed` / `abandoned`
attributes rather than inside a sentence. `startFailed` and `uncaught` are
`error` lines carrying their cause; `teardownError` is a `warn`, because the
application is already stopping and the exit code already says `2`.

::: warning Build this logger by hand
It is the one logger the framework asks anybody to construct, and it has to
be: `building` is emitted **while the graph is still being built**, and
`startFailed` when it never finished, so a sink resolved from the context it
is watching would have nothing to write the two events that matter most with.
It reads no `LOG_LEVEL` for the same reason, and logs at the default `info`.
:::

`examples/order-api/src/main.ts` wires exactly this; the other two example
`main.ts` files stay a single line, because the kernel's stderr sink is a fine
default and this is the upgrade, not the requirement.

## Provide your own `Logger`

`observability()` is the default, not the only way. A test that wants silence,
or an application with a logger of its own, provides the port directly and
nothing else in the graph can tell:

```ts
Provider(Logger)({ value: createLogger(() => {}) });
```

More usefully, keep the shipped implementation and replace only the
**destination** — a `Sink` is a plain function, so the lines come back as
values:

```ts
const lines: Line[] = [];

const RecordingApi = HttpModule("RecordingApi")({
  needs: [Env],
  router: orderRouter,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability({ sink: (line) => lines.push(line), level: "trace" }),
  ],
  exports: [Logger],
});
```

That is what the example suites do. A spec then asserts on the line's
**fields** — `line.attributes.orderId`, `line.unit?.traceId` — instead of
matching a substring, and `level: "trace"` is pinned so the environment cannot
silence the very thing the test is reading. The roots a spec boots only to
exercise a transport pass a no-op sink instead, so a test run is not also a
log dump.

::: tip Booting without the kernel
`observability()` binds its level from the `Env` port `start` provides. A
kernel-free `Module.scoped` has no `start`, so provide an empty one:
`Provider(Env)({ value: {} })`. That is the only ceremony the real logger
costs a spec, and it buys the very implementation the deployments run.
:::

## See also

- [`@btravstack/observability`](/reference/observability) — every export, the
  `Line` contract and the full `kernelEvents` table.
- [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit) — the
  record the logger reads, and who else may read it.
- [Configure from the environment](/how-to/configure-from-the-environment) —
  how `LOG_LEVEL` is bound, and what a bad one costs.
- [Test an application](/how-to/test-an-application) — the fixtures the
  recording sink above belongs to.
