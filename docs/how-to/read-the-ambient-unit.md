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
`tenantId` and `deadline` are plain data the runtime may stamp; **no shipped
starter sets either today**. `signal` is always there: the kernel mints one
`AbortController` per unit, hands its signal to the work callback **and** puts
that same object on the record, so both routes see one abort — at the drain
deadline, or at once on a path that skips the drain.

## Who may read it

| Reader                                                     | Reads `currentUnit()`? |
| ---------------------------------------------------------- | ---------------------- |
| a logger adapter                                           | yes                    |
| an OTel exporter or span processor                         | yes                    |
| a database adapter stamping `tenantId` on a query          | yes                    |
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

## Recipe: a logger that stamps the trace id

Read the record at **call time**, never at construction: one logger is built
per scope, but each unit has its own record.

```ts
import { currentUnit } from "@btravstack/core";
import { Port, Provider } from "@btravstack/di";

class Logger extends Port("Logger")<{
  readonly info: (message: string) => void;
}> {}

const loggerProvider = Provider(Logger)({
  sync: () => ({
    info: (message: string) => {
      const unit = currentUnit();
      process.stderr.write(
        `${JSON.stringify({ message, traceId: unit?.traceId, tenantId: unit?.tenantId })}\n`,
      );
    },
  }),
});
```

That is exactly what `examples/order-application/src/logger.ts` does — the
single kernel touchpoint in that layer, and the logger every use case writes
to:

```ts
export const loggerProvider = Provider(Logger)({
  sync: () => {
    const lines: string[] = [];
    return {
      info: (message: string) => {
        lines.push(`[${currentUnit()?.traceId ?? "-"}] ${message}`);
      },
      lines: () => lines,
    };
  },
});
```

Outside a unit — the package's own specs, a startup log — there is no record
and the line reads `[-]`. `examples/order-api/src/api.spec.ts` asserts two
calls produce two distinct trace ids and never `[-]`, which is how the
convention is kept honest against the real HTTP runtime.

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
kernel's. On AMQP, an un-acked delivery goes back to the broker, so a
`RetryableError` hands the message to the next worker —
`examples/order-amqp-worker/src/handlers.ts`:

```ts
export const orderHandlers = AmqpHandlers(orderContract)([Logger], {
  sync: (logger) => ({
    orderChanged: (message) => {
      const { id, payload } = message.payload;
      if (currentUnit()?.signal.aborted === true) {
        return ErrAsync(
          new RetryableError(
            `the drain deadline passed before order ${id} was notified`,
          ),
        );
      }
      logger.info(`order ${id} placed — notifying`);
      return OkAsync();
    },
  }),
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
        : (logger.info(`arranged shipping for order ${orderId}`), OkAsync()),
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
