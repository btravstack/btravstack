---
title: Read the ambient unit from an adapter
description: Stamp a trace id on every log line with currentUnit(), honour the drain deadline from an activity or a handler, know which code may read it, and see how each starter fills the record.
---

<!-- doctest: prelude
import { Port } from "@btravstack/di";
import { currentUnit } from "@btravstack/core";
-->

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

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

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
`tenantId` and `deadline` are plain data the runtime may stamp; **no shipped
starter sets either today**, and none has a tenancy concept — see
[Multi-tenancy is the application's, not the framework's](#multi-tenancy-is-the-application-s-not-the-framework-s). `signal` is always there: the kernel mints one
`AbortController` per unit, hands its signal to the work callback **and** puts
that same object on the record, so both routes see one abort — at the drain
deadline, or at once on a path that skips the drain.

## Multi-tenancy is the application's, not the framework's

`UnitRecord` has a `tenantId` field and **no shipped starter sets it.** That is
deliberate, and it is worth saying why, because the field's presence invites
the opposite conclusion.

A tenant is _context_, and context is the application's to own. What
establishes it — a header, a subdomain, an authenticated subject, a field on
the message — is a decision about a specific system, and so is what happens
when it is missing. A starter that read a tenant off a request would be
deciding both on the application's behalf, and it would be the beginning of a
framework tenancy model that has to answer many more questions than that one.
The `tenantId` field exists for a **hand-rolled** runtime whose author has
already answered them.

The example application is multi-tenant, and it needs none of that. It makes
the tenant part of its **own** vocabulary — the ports name it, so it is an
argument a caller cannot forget and a reader can see:

**`examples/order-application/src/ports.ts`**

<!-- doctest: skip — quotes examples/order-application/src/ports.ts, which its own workspace compiles -->

```ts
export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (
    tenantId: TenantId,
    order: Order,
  ) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (
    tenantId: TenantId,
    id: string,
  ) => AsyncResult<Order, OrderNotFound>;
  readonly remove: (
    tenantId: TenantId,
    id: string,
  ) => AsyncResult<void, OrderNotFound>;
}> {}
```

`TenantId` is a branded `string` the domain owns, and the ids beside it are
not: a pair need differ in one position to become unswappable, and
`find(id, tenantId)` used to compile and query the wrong tenant. Each
transport claims the brand once, where a validated value arrives — the
authenticator, an activity's input, the relay's own configuration.

Each transport then supplies it from its own contract, which is where a client
already has to say what it wants:

| Deployment              | Where the tenant comes from                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `order-api`             | an input field on a public procedure (`Tenanted`), the authenticated caller's principal on a marked one |
| `order-amqp-worker`     | a field on the broadcast envelope                                                                       |
| `order-temporal-worker` | a field on every workflow and activity input                                                            |

Two consequences are the point rather than the price. A use case that forgot
its tenant **does not compile**, where an ambient one would have failed at
runtime or, worse, silently read the wrong tenant's rows. And a test needs no
machinery at all: `repository.find(tenant, "0199a1e0-0000-7000-8000-000000000001")` says what it is scoped to
at the call, with no fixture that "enters" a tenant and no store to set.

The relay in `order-amqp-worker` is the case that shows why ambient would not
have been enough anyway: it sweeps on its own clock, with no request, delivery
or activity behind it, so there is no unit to read a tenant from. Which tenants
it serves is deployment configuration (`OUTBOX_TENANTS`) — a question ambient
context cannot answer.

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

<!-- doctest: skip — a one-line call excerpt of the interactor shown in docs/how-to/log-and-correlate.md -->

```ts
logger.info("placing an order", { orderId: id, quantity });
```

```json
{
  "orderId": "0199a1e0-0000-7000-8000-000000000001",
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
  inject: {},
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

| Runtime                       | Where the signal is                                                          |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `@btravstack/http-server`     | the handler's third parameter — and `currentUnit()?.signal`, the same object |
| `@btravstack/temporal-worker` | `currentUnit()?.signal` only                                                 |
| `@btravstack/amqp-worker`     | `currentUnit()?.signal` only                                                 |

The two workers are middleware-shaped: the kernel's work callback is the
library's `next()`, so an activity or a handler has **no parameter** to receive
a signal through. Injecting a context the contract does not type was the
alternative, and it is the hidden-dependency shape this stack exists to avoid.

What you answer when the signal has fired is the transport's business, not the
kernel's, and it is a **slice's own** business now: `order-amqp-worker`'s two
subscribers answer differently. On AMQP, an un-acked delivery goes back to the
broker, so a `RetryableError` hands the message to the next worker —
`examples/order-amqp-worker/src/slices/notifications/handler.ts`:

<!-- doctest: skip — quotes the amqp handler compiled by docs/examples/order-amqp-worker.md's group -->

```ts
export const orderNotifications = AmqpHandler(
  orderContract,
  "orderNotifications",
)({
  inject: { logger: Logger },
  sync:
    ({ logger }) =>
    ({ input: message }) => {
      const { tenantId, id, payload } = message.payload;
      if (currentUnit()?.signal.aborted === true) {
        return ErrAsync(
          new RetryableError(
            `the drain deadline passed before order ${id} was notified`,
          ),
        );
      }
      logger.info(
        payload === null
          ? "order gone — notifying"
          : "order placed — notifying",
        {
          tenantId,
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

<!-- doctest: skip — quotes examples/order-temporal-worker/src/fulfillment.ts, which the gate compiles -->

```ts
Provider(ShippingService)({
  inject: { logger: Logger },
  sync: ({ logger }) => ({
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

| Starter                       | `kind`       | `id`                    | `traceId`                                                     |
| ----------------------------- | ------------ | ----------------------- | ------------------------------------------------------------- |
| `@btravstack/http-server`     | `"http"`     | `randomUUID()`          | the `x-request-id` header, else the id                        |
| `@btravstack/temporal-worker` | `"activity"` | the activity task token | the workflow id, else the activity id — stable across retries |
| `@btravstack/amqp-worker`     | `"delivery"` | `randomUUID()`          | `messageId`, else `correlationId`, else the id                |

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
