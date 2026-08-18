---
title: Read the ambient unit from an adapter
description: Stamp a trace id on every log line with currentUnit(), honour the drain deadline from an activity or a handler, know which code may read it, and see how each starter fills the record.
---

# Read the ambient unit from an adapter

> **How-to.** Read the kernel's per-unit record — trace id, tenant id,
> deadline, the unit's `AbortSignal` — from a logger, an exporter, a database
> adapter or an activity, without
> threading it through every signature. For _why_ this is data and not a
> capability, see [Ambient data, injected capabilities](/explanation/ambient-vs-context).

The kernel opens one `AsyncLocalStorage` store per unit and puts a small, fixed
record in it. `currentUnit()` reads it from anywhere in the unit's async
continuation, `undefined` outside one.

## The record

```ts
type UnitRecord = {
  readonly unitId: string; // minted per unit by the kernel, always unique
  readonly traceId: string; // the correlation id — `UnitMeta.traceId`, defaulting to `UnitMeta.id`
  readonly tenantId: string | undefined; // `UnitMeta.tenantId`, if the runtime supplied one
  readonly deadline: number | undefined; // `UnitMeta.deadline`, if the runtime supplied one
  readonly signal: AbortSignal; // the unit's own — the very one the work callback is handed
};
```

`unitId` tells two units apart and needs nothing from the runtime. `traceId` is
the one that joins a line logged here to a trace that started elsewhere.
`deadline` is plain data a runtime may stamp; no shipped starter sets it today.
`tenantId` is stamped by whichever starter you gave a **`tenantOf`** to — see
[Make an application multi-tenant](#make-an-application-multi-tenant) below. `signal` is always there: the kernel mints one
`AbortController` per unit, hands its signal to the work callback **and** puts
that same object on the record, so both routes see one abort — at the drain
deadline, or at once on a path that skips the drain.

## Make an application multi-tenant

All three starters take one optional `tenantOf`, and it does the same thing in
each: reads a tenant off the transport's own input and puts it on
`UnitMeta.tenantId`, from where the kernel puts it on the record.

| Starter                | `tenantOf` receives                                        |
| ---------------------- | ---------------------------------------------------------- |
| `@btravstack/http`     | the `IncomingMessage`                                      |
| `@btravstack/amqp`     | the delivery — validated `message`, and the `rawMessage`   |
| `@btravstack/temporal` | the activity invocation — its validated `input`, and names |

```ts
// examples/order-api/src/module.ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  tenantOf: (request) => {
    const header = request.headers["x-tenant-id"];
    return typeof header === "string" ? header : undefined;
  },
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

```ts
// examples/order-infrastructure/src/prisma-order-repository.ts
find: (id) =>
  currentTenant()
    .toAsync()
    .flatMap((tenantId) =>
      db.order.tryFindUnique({ where: { tenantId_orderId: { tenantId, orderId: id } } }),
    )
    .flatMap((row) => (row === null ? Err(new OrderNotFound({ id })) : hydrate(row))),
```

That is the whole of it. The adapter is the only file that mentions a tenant:
no procedure takes one, no use case names one, no entity has a field for one,
because none of them has a decision to make about it. A tenant is not an
argument to placing an order; it is who is asking.

Three things worth deciding deliberately:

- **The whole input is handed to `tenantOf`** because only the application
  knows where its own tenant lives — a header, a subdomain, a message
  property, a workflow argument. `examples/order-temporal-worker` puts it on
  the activity **input** rather than a Temporal header, because an input is
  persisted in the event history and a replay reconstructs it.
- **The starter maps nothing beyond that.** Refusing work that carries no
  tenant is a decision about a status code, an ack/nack or an activity
  failure, and the starters decline those — it belongs in a procedure or a
  handler, next to the rest of the triage.
- **Code with no unit has no tenant.** A background sweep — a relay polling an
  outbox — has no request, delivery or activity behind it, so it must be
  _told_: `examples/order-amqp-worker`'s relay reads `OUTBOX_TENANTS` and
  `Outbox.pending(tenantId, limit)` takes its tenant as an argument. That is
  the one port in the example that does, and the reason is worth keeping.

To test an adapter that reads the record, use
[`@btravstack/testing`'s `unitFixture`](/reference/testing#unitfixture): only a
runtime opens a unit, and in a test that runtime is the harness's.

## Who may read it

| Reader                                                     | Reads `currentUnit()`? |
| ---------------------------------------------------------- | ---------------------- |
| a logger adapter                                           | yes                    |
| an OTel exporter or span processor                         | yes                    |
| a database adapter scoping a query by `tenantId`           | yes                    |
| an adapter checking `signal` before an outbound call       | yes                    |
| a Temporal activity or an AMQP handler honouring the drain | yes — see below        |
| a use case, a domain service, a router procedure           | **no**                 |

The line holds because what di exists to prevent is hidden _dependencies_:
code that secretly needs a collaborator it never declared. A trace id is not a
collaborator — no substitutability question, no test double, nothing to swap.
A repository pulled from an ambient store would be the untestable coupling; a
tenant id read by the Postgres adapter is not.

::: warning
Application code reading the store is meant to be a lint error, in the spirit
of `unthrown/no-catch-all-pattern`. **That rule does not exist yet** — it needs
a way to identify an adapter, which this stack has not established — so today
this is a convention, held by review, not an enforcement.
:::

## The logger is already written

The canonical reader ships:
[`@btravstack/observability`](/reference/observability). Import
`observability()` next to your application and every line an application
writes carries the unit it was written in, with nothing in the application
mentioning correlation:

```ts
logger.info("placing an order", { orderId: id, quantity });
```

```json
{
  "orderId": "o-1",
  "quantity": 2,
  "time": "2026-08-16T09:41:02.113Z",
  "level": "info",
  "message": "placing an order",
  "unitId": "0f2a…",
  "traceId": "b41e…"
}
```

`examples/order-api/src/api.spec.ts` asserts that two calls produce four lines
carrying two distinct trace ids, and none written outside a unit — which is
how the convention is kept honest against the real HTTP runtime. Reach for the
recipe below only for an adapter of your own: an exporter, a database adapter,
a second destination.

## Recipe: an adapter of your own

Read the record at **call time**, never at construction: one adapter is built
per scope, but each unit has its own record.

```ts
import { currentUnit } from "@btravstack/core";
import { Port, Provider } from "@btravstack/di";

class Audit extends Port("Audit")<{
  readonly record: (action: string) => void;
}> {}

const auditProvider = Provider(Audit)({
  sync: () => ({
    record: (action: string) => {
      const unit = currentUnit();
      process.stderr.write(
        `${JSON.stringify({ action, traceId: unit?.traceId, tenantId: unit?.tenantId })}\n`,
      );
    },
  }),
});
```

That is what `createLogger` does, minus the level filter and the `try` that
makes a broken destination survivable. Outside a unit — a package's own specs,
a startup line — `currentUnit()` is `undefined`, and the fields are simply
absent.

A unit-scoped finaliser runs **while the unit is still open**, so a
`StartOptions.unit` module's `onStop` logging "request finished" carries the
request's own trace id — `examples/order-api/src/request-scope.ts` relies on
exactly that.

## Recipe: honour the drain deadline

The record's `signal` is the unit's own. When the drain runs out of time the
kernel aborts every unit still open, and work that keeps going is work nobody
in this process is waiting for any more.

Which route you take to the signal depends on the runtime's shape:

| Runtime                | Where the signal is                                                          |
| ---------------------- | ---------------------------------------------------------------------------- |
| `@btravstack/http`     | the handler's third parameter — and `currentUnit()?.signal`, the same object |
| `@btravstack/temporal` | `currentUnit()?.signal` only                                                 |
| `@btravstack/amqp`     | `currentUnit()?.signal` only                                                 |

The two workers are middleware-shaped: the kernel's work callback is the
library's `next()`, so an activity or a handler has **no parameter** to receive
a signal through. Injecting a context the contract does not type was the
alternative, and it is the hidden-dependency shape this stack exists to avoid.

What you answer when the signal has fired is the transport's business, not the
kernel's, and it is a **slice's own** business now: `order-amqp-worker`'s two
subscribers answer differently. On AMQP, an un-acked delivery goes back to the
broker, so a `RetryableError` hands the message to the next worker —
`examples/order-amqp-worker/src/slices/notifications/handler.ts`:

```ts
export const orderNotifications = AmqpHandler(
  orderContract,
  "orderNotifications",
)([Logger], {
  sync: (logger) => (message) => {
    const { id, payload } = message.payload;
    if (currentUnit()?.signal.aborted === true) {
      return ErrAsync(
        new RetryableError(
          `the drain deadline passed before order ${id} was notified`,
        ),
      );
    }
    logger.info(
      payload === null ? "order gone — notifying" : "order placed — notifying",
      {
        orderId: id,
        ...(payload === null ? {} : { quantity: payload.quantity }),
      },
    );
    return OkAsync();
  },
});
```

On Temporal, the platform retries an attempt that fails as a **defect** on
another worker, which is the right shape for "we ran out of time" — where the
contract's own `ShippingUnavailable` is a permanent no and would be the wrong
error. `examples/order-temporal-worker/src/fulfillment.ts`:

```ts
Provider(ShippingService)([Logger], {
  sync: (logger) => ({
    arrange: (orderId) =>
      currentUnit()?.signal.aborted === true
        ? fromSafePromise(
            Promise.reject(
              new Error(
                `the drain deadline passed before shipping for ${orderId} was arranged`,
              ),
            ),
          )
        : (logger.info("arranged shipping", { orderId }), OkAsync()),
  }),
});
```

A transport's **own** cancellation is a different clock and stays separate.
Temporal's `Context.current().cancellationSignal` fires on a workflow-side
cancellation and on worker shutdown after `shutdownGraceTime`; AMQP has none at
all. Honour both where both exist — neither stands in for the other.

## How each starter fills `traceId`

Every shipped runtime mints `UnitMeta.id` fresh per unit and puts the
correlation id in `traceId`, adopting an inbound value only when it is
non-blank:

| Starter                | `kind`       | `id`                    | `traceId`                                                     |
| ---------------------- | ------------ | ----------------------- | ------------------------------------------------------------- |
| `@btravstack/http`     | `"http"`     | `randomUUID()`          | the `x-request-id` header, else the id                        |
| `@btravstack/temporal` | `"activity"` | the activity task token | the workflow id, else the activity id — stable across retries |
| `@btravstack/amqp`     | `"delivery"` | `randomUUID()`          | `messageId`, else `correlationId`, else the id                |

So a client that sets `x-request-id`, a workflow that starts an activity, and a
publisher that sets `messageId` each get every line the unit logs stamped with
an id they already hold. A runtime of your own follows the same rule — see
[Write a runtime](/how-to/write-a-runtime).

## See also

- [Ambient data, injected capabilities](/explanation/ambient-vs-context) — the
  reasoning, and where the line would be crossed.
- [Open a per-request scope](/how-to/open-a-per-request-scope) — the
  `StartOptions.unit` module whose teardown logs under the unit's trace id.
- [Write a runtime](/how-to/write-a-runtime) — the `UnitMeta` a runtime
  submits, and why `id` must be unique.
- [Log and correlate](/how-to/log-and-correlate) — the shipped reader of this
  record, end to end.
