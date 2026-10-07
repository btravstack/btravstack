# `@btravstack/core` example: the order Temporal contract

The Temporal contract — one **task queue**, two saga workflows and a scheduled sweep, and the errors
a caller may branch on — in a package of its own, depending on
`@temporal-contract/contract` and `zod`.

`fulfillOrder` is the orders saga: five activities (three forward steps, two
compensations), four declared errors. `chargeOrder` is a second saga on the
**same** queue — a second vertical, since taking the money is not part of
placing, reserving or shipping the order: three activities (two forward steps,
one compensation), one declared error, `PaymentDeclined`.

The shape of both sagas is legible in the contract alone: the forward steps
declare their permanent domain answers `nonRetryable`, and every compensation
— `releaseStock`, `cancelPlacement`, and `chargeOrder`'s own `refundPayment` —
declares **no errors at all**. Compensation is the saga un-deciding, and a
step that could answer "no" would leave it stuck half-done, so whatever
infrastructure trouble a compensation hits stays undeclared and Temporal
retries it until it works. `refundPayment` follows the same rule for the same
reason `releaseStock` does — there is nothing saga-specific about it.

`sweepStaleOrders` is the third workflow and not a saga: one activity,
`withdrawStaleOrders`, with no errors declared for the compensations' own
reason, fired by a Temporal Schedule rather than by any caller. It is still
the contract's because a schedule's action is an ordinary workflow start, read
off the same task queue and validated against the same input schema.

```text
src/contract.ts        the contract: schemas, declared errors, activity options, task queue
src/layering.test-d.ts the dependency rule, as a compile error
src/__tests__/test-fixtures.ts   the contract's own schema, as a validator returning a Result
```

## Why it is not part of `order-temporal-worker`

A contract is a **shared artifact**. Temporal's version of the point is sharper
than oRPC's, because three parties read this file: the worker that implements
the activity, the workflow that runs in the sandbox, and the client that starts
the execution. Only the first of those wants a di container, a Prisma-backed
repository and the kernel.

```text
   order-temporal-worker        any client starting a workflow
         └──────────┬──────────┘
                    ▼
       order-temporal-contract     ← @temporal-contract/contract and zod, nothing else
```

`src/layering.test-d.ts` is that sentence as a compile error: it imports
`@btravstack/example-order-temporal-worker` under a `@ts-expect-error`, so the
day this package gains a dependency on the worker it describes, `typecheck`
fails because the directive stops being used.

## `place` names its operation, optionally

`place`'s input carries an `operationId` — the workflow's run id — so the
repository can tell a retried attempt recovering its own committed write from
a different execution placing the same order id. It is **optional** because a
contract outlives a deploy: a `place` task the previous workflow version
scheduled carries none, and a required field would have the new worker refuse
it at validation, failing an in-flight fulfillment. Absent, the placement is
insert-only, as it was before.

## The schemas are the demonstration

Where the oRPC contract's proof is a client built from it, this one's is that
the contract is **executable**: `src/contract.spec.ts` runs each workflow's
own input schema through `@unthrown/standard-schema`'s `fromSchema` and gets a
`Result`, with no worker, no connection and no activity implementation in
scope — which is exactly the check a caller makes before starting an
execution. `chargeOrder`'s own case is a single valid payload, proving the
contract holds more than one workflow rather than re-running the invalid-input
case `fromSchema` itself already covers.

There is no client-side test beyond that, and that is a property of Temporal
rather than an omission: a `TypedClient` needs a running service to talk to, so
"a client built from the contract alone" is what `order-temporal-worker`'s own suite
already exercises against the time-skipping test server.

`zod` is a runtime dependency because the schemas **are** the contract — they
travel to the client, which validates against them. `unthrown` is a dev
dependency only: it satisfies the optional peer `@temporal-contract/contract`
declares (keeping one copy of it across the workspace) and backs the spec's
matchers.
