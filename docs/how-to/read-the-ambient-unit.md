---
title: Read the ambient unit from an adapter
description: Stamp a trace id on every log line with currentUnit(), know which code may read it, and see how each starter fills the record.
---

# Read the ambient unit from an adapter

> **How-to.** Read the kernel's per-unit record — trace id, tenant id,
> deadline — from a logger, an exporter or a database adapter, without
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
};
```

`unitId` tells two units apart and needs nothing from the runtime. `traceId` is
the one that joins a line logged here to a trace that started elsewhere.
`tenantId` and `deadline` are plain data the runtime may stamp; **no shipped
starter sets either today**. Cancellation is not the record's job — the
`AbortSignal` the kernel hands unit work is what fires at the drain deadline.

## Who may read it

| Reader                                            | Reads `currentUnit()`? |
| ------------------------------------------------- | ---------------------- |
| a logger adapter                                  | yes                    |
| an OTel exporter or span processor                | yes                    |
| a database adapter stamping `tenantId` on a query | yes                    |
| a use case, a domain service, a router procedure  | **no**                 |

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
