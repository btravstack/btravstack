# `@btravstack/core` example: the order Temporal contract

The Temporal contract — one saga workflow, its five activities (three forward
steps, two compensations), and the four errors a caller may branch on — in a
package of its own, depending on `@temporal-contract/contract` and `zod`.

The shape of the saga is legible in the contract alone: the forward steps
declare their permanent domain answers `nonRetryable`, and the two
compensations declare **no errors at all** — compensation is the saga
un-deciding, and a step that could answer "no" would leave it stuck half-done,
so whatever infrastructure trouble a compensation hits stays undeclared and
Temporal retries it until it works.

```
src/contract.ts        the contract: schemas, declared errors, activity options, task queue
src/layering.test-d.ts the dependency rule, as a compile error
src/test-fixtures.ts   the contract's own schema, as a validator returning a Result
```

## Why it is not part of `order-temporal-worker`

A contract is a **shared artifact**. Temporal's version of the point is sharper
than oRPC's, because three parties read this file: the worker that implements
the activity, the workflow that runs in the sandbox, and the client that starts
the execution. Only the first of those wants a di container, a Prisma-backed
repository and the kernel.

```
   order-temporal-worker        any client starting a workflow
         └──────────┬──────────┘
                    ▼
       order-temporal-contract     ← @temporal-contract/contract and zod, nothing else
```

`src/layering.test-d.ts` is that sentence as a compile error: it imports
`@btravstack/example-order-temporal-worker` under a `@ts-expect-error`, so the
day this package gains a dependency on the worker it describes, `test:types`
fails because the directive stops being used.

## The schemas are the demonstration

Where the oRPC contract's proof is a client built from it, this one's is that
the contract is **executable**: `src/contract.spec.ts` runs the workflow's own
input schema through `@unthrown/standard-schema`'s `fromSchema` and gets a
`Result`, with no worker, no connection and no activity implementation in
scope — which is exactly the check a caller makes before starting an execution.

There is no client-side test beyond that, and that is a property of Temporal
rather than an omission: a `TypedClient` needs a running service to talk to, so
"a client built from the contract alone" is what `order-temporal-worker`'s own suite
already exercises against the time-skipping test server.

`zod` is a runtime dependency because the schemas **are** the contract — they
travel to the client, which validates against them. `unthrown` is a dev
dependency only: it satisfies the optional peer `@temporal-contract/contract`
declares (keeping one copy of it across the workspace) and backs the spec's
matchers.
