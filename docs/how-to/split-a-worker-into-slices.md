---
title: Split a worker into slices
description: Give each consumer or workflow its own slice, and compose them into one handlers or activities record with AmqpHandler or TemporalWorkflowActivities.
---

<!-- doctest: prelude
import { Logger, Tracer } from "@btravstack/core";
import { AmqpHandler, AmqpHandlers, AmqpModule } from "@btravstack/amqp-worker";
import { Config, Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OkAsync } from "unthrown";
import {
  OrderApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { outboxRelay, relayConfig } from "../../outbox-relay.js";
import { orderAudit } from "../../slices/audit/handler.js";
import { AuditSlice } from "../../slices/audit/module.js";
-->

# Split a worker into slices

> **How-to.** For an AMQP consumer or a Temporal worker that has outgrown one
> `AmqpHandlers(contract)({ inject, ...arm })` or `TemporalActivities(contract)({ inject, ...arm })`.
> For the single-record shape, see
> [Consume AMQP messages](/how-to/consume-amqp-messages) and
> [Run a Temporal worker](/how-to/run-a-temporal-worker).

`AmqpHandlers(contract)({ inject, ...arm })` and
`TemporalActivities(contract)({ inject, ...arm })` put every consumer's or every workflow's implementation in one
function — right for a worker with one or two of them, wrong once a worker
grows enough consumers or workflows that one function means one slice's typo
failing the whole record's type-check. A **piece** is the fix: one consumer or
one workflow as an ordinary di provider, minted its own port from the
contract key, composed by the root into an array. Everything below is lifted
from `examples/order-amqp-worker` (two subscriber slices) and
`examples/order-temporal-worker` (two saga slices).

## Why a worker's array has no nested paths

[Split a router into controllers](/how-to/split-a-router-into-controllers)
starts from a contract that is already nested — `{ orders: {...}, customers:
{...} }` — and mints each piece from the **path** it serves, `"orders"` or a
nested `"v1.orders"`, composing them with `api.OrpcRouter(contract)([...])`.
An `amqp-contract` or `temporal-contract` contract has no such nesting: its
consumers and its workflows are already flat top-level keys of one contract,
not fragments of it, so a worker piece owns exactly one key and the key space
never nests. Both starters mint the same way —
`AmqpHandler(contract, key)` / `TemporalWorkflowActivities(contract, key)` —
and compose an **array** the same way —
`AmqpHandlers(contract)([...])` / `TemporalActivities(contract)([...])` —
reaching the same exactness HTTP's array does: each piece's port id carries
the key it targets, so the array itself needs no keys at all. One shape, all
three transports; the one degree of freedom HTTP alone has is depth.

## Step 1 — a piece per consumer or per workflow

`AmqpHandler(contract, key)` and `TemporalWorkflowActivities(contract, key)`
are `AmqpHandlers(contract)` / `TemporalActivities(contract)`'s own shape,
aimed at one key: the first call fixes the key's type and mints a port under
it — there is no name to give, since the contract key **is** the port's
name — and the second is di's own `Provider(port)({ inject: deps, sync })`, so
`sync`'s return is typed by that one key alone. A handler or an activity
record whose message or input has drifted is a compile error inside the
piece's own file, not at the root:

**`slices/notifications/handler.ts`**

<!-- doctest: group=order-amqp-worker -->

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
      logger.info(
        payload === null
          ? "order gone — notifying"
          : "order placed — notifying",
        {
          tenantId,
          orderId: id,
        },
      );
      return OkAsync();
    },
});
```

**`slices/billing/activities.ts`**

<!-- doctest: skip — needs `@btravstack/temporal-worker`, which this page's amqp workspace does not install; the same shape is compiled by docs/examples/order-temporal-worker.md -->

```ts
export const chargeOrder = TemporalWorkflowActivities(
  orderContract,
  "chargeOrder",
)({
  inject: { payments: PaymentService },
  sync: ({ payments }) => ({
    authorizePayment: ({ errors, idempotencyKey, input }) =>
      payments
        .authorize(input.orderId, input.amount, idempotencyKey)
        .map((authorizationId) => ({ authorizationId }))
        .mapErrCases((matcher) =>
          matcher.with(P.tag("PaymentDeclined"), (error) =>
            errors.PaymentDeclined({ id: error.id }),
          ),
        ),
    capturePayment: ({ idempotencyKey, input }) =>
      payments.capture(input.authorizationId, idempotencyKey),
    refundPayment: ({ idempotencyKey, input }) =>
      payments.refund(input.authorizationId, idempotencyKey),
  }),
});
```

Each piece declares only the ports **it** calls: `orderNotifications` takes
`Logger` and knows nothing of the audit slice's; `chargeOrder` takes
`PaymentService` and knows nothing of `PlaceOrder`, the fulfillment saga's own
use case. A subscriber and a workflow differ in what they are allowed to own,
not in the shape of the piece itself — see **What a slice owns** below.

## Step 2 — the slice module that exports the piece

A piece ships as a module that provides and exports it, the same privacy di
gives any provider:

```ts
export const NotificationsSlice = Module("NotificationsSlice")({
  needs: [Logger],
  provides: [orderNotifications],
  exports: [orderNotifications],
});
```

<!-- doctest: skip — needs `@btravstack/temporal-worker`, which this page's amqp workspace does not install; the same shape is compiled by docs/examples/order-temporal-worker.md -->

```ts
export const BillingSlice = Module("BillingSlice")({
  needs: [Logger],
  imports: [BillingModule],
  provides: [chargeOrder],
  exports: [chargeOrder],
});
```

`exports: [chargeOrder]` is the provider itself, not a port class:
`TemporalWorkflowActivities` (like `AmqpHandler`) mints the port from the
contract key, so there is no class to spell back off it. `BillingSlice`
imports `BillingModule` because `chargeOrder`'s activities close over
`PaymentService`; `NotificationsSlice` imports nothing, because a subscriber
reacting to a fact somebody else committed owns no domain and no persistence
at all. Both are still slices in exactly the sense
[Split a router into controllers](/how-to/split-a-router-into-controllers)
uses the word — a module that owns one piece of the surface and exports only
that piece's port.

## Step 3 — the root's array

The root composes every slice's piece into the one record the starter needs:

```ts
export const orderHandlers = AmqpHandlers(orderContract)([
  orderNotifications,
  orderAudit,
]);
```

<!-- doctest: skip — needs `@btravstack/temporal-worker`, which this page's amqp workspace does not install; the same shape is compiled by docs/examples/order-temporal-worker.md -->

```ts
export const orderActivities = TemporalActivities(orderContract)([
  fulfillOrder,
  chargeOrder,
]);
```

Di constructs every piece first — they are the composed provider's own
`deps`, declared under the very key each piece's port id carries, so the
services record IS the record the starter needs. The composed provider's own
`deps` are the **pieces' ports**, not what a piece closes over, so a piece still needs
discharging like any other need: the root **imports every slice module**,
even though nothing in it names a piece directly —

```ts
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    observability(),
    otel(),
  ],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger, Tracer],
});
```

Dropping a slice's import here still fails to compile: `AmqpHandlers` /
`TemporalActivities` declare each piece's port as one of the composed
provider's own `deps`, so a missing import is an undeclared need at this
very call, and di's `NeedsGate` refuses the module, naming the exact port —
caught by `pnpm typecheck`, not by a runtime `WiringDefect`.

## Sequencing a saga: `context.saga()`, never sibling `const`s

An `AsyncResult` is **eager** — constructing it starts the work. So the
readable spelling of a sequence, each step in its own `const` and then chained,
is a **race**: it type-checks, it returns a `Result`, and it runs the steps
concurrently. Nothing catches it.

Where the steps carry compensations, `context.saga()` is the answer. Every
argument is a **thunk**, so nothing is built before the saga reaches it, and
the undos are its own business rather than each step's:

<!-- doctest: skip — a saga excerpt with elided arms; the full workflow is compiled by docs/examples/order-temporal-worker.md -->

```ts
context
  .saga()
  .step(
    () => context.activities.place(order),
    () => context.activities.cancelPlacement(order),
  )
  .step(
    () => context.activities.reserveStock(order),
    () => context.activities.releaseStock(order),
  )
  .step(() => context.activities.arrangeShipping(order))
  .run()
  .mapErrCases(/* one triage, at the end */);
```

`context.saga()` runs the undos **LIFO** and decides which failures earn one: a
declared contract error compensates, an activity that failed unmodelled or was
cancelled does not — a step that died mid-flight left state nobody can see. So
the machinery-tag arm every step used to repeat is gone, and the re-mint
against `context.errors` happens once.

A sequence with **no** compensations does not need a saga:
[`flatTap`](https://github.com/btravstack/unthrown) runs a failable step,
discards its value and passes the **original** one through, so the next step is
a callback that cannot start before the previous settles. Where a later step
needs an earlier step's _value_ rather than just its success,
`DoAsync().bind("name", (scope) => …)` is the same idea with an accumulating
scope. See [Order Temporal worker](/examples/order-temporal-worker) for all
three at full size.

## What a mistake looks like at compile time

Two mistakes are caught before the array is ever composed, both inside
`AmqpHandler(contract, key)` / `TemporalWorkflowActivities(contract, key)`'s
own call:

<!-- doctest: skip — quotes the gates packages/amqp-worker/src/handler.test-d.ts and packages/temporal-worker/src/workflow-activities.test-d.ts pin for real -->

```ts
// @ts-expect-error -- "notAKey" is not one of orderContract's consumer/rpc names
AmqpHandler(orderContract, "notAKey");

// @ts-expect-error -- "notAWorkflow" is not a top-level key of orderContract's activities record
TemporalWorkflowActivities(orderContract, "notAWorkflow");
```

there is nothing to type `key` by, so a typo or a key from the wrong contract
is refused right there — not at the root, and not at startup.

The third is caught at the composing call. `AmqpHandlers(contract)([...])`
and `TemporalActivities(contract)([...])` are exact against every top-level
key the contract declares: an array missing one is refused, against an
`"UNCOVERED HANDLERS — …"` / `"UNCOVERED ACTIVITIES — …"` marker rather than a
runtime stack trace, and never a silent failure or an `undefined` merged into
the record:

<!-- doctest: skip — quotes the gates packages/amqp-worker/src/handler.test-d.ts and packages/temporal-worker/src/workflow-activities.test-d.ts pin for real -->

```ts
// @ts-expect-error -- the "orderAudit" consumer is uncovered
AmqpHandlers(orderContract)([orderNotifications]);

// @ts-expect-error -- the "fulfillOrder" key is uncovered
TemporalActivities(orderContract)([chargeOrder]);
```

**Where the marker actually is.** Both are a `TS2769`, three lines long, with
the sentence at the **tail of the third line** — and the missing key beside it,
whatever the array's length:

```text
… is not assignable to type 'readonly ["UNCOVERED HANDLERS — the contract declares a consumer this array does not cover", "right"]'.
```

Read the last line and read it from the end; the width in front of it is your
own contract, expanded. Why it prints there, and what every other marker in
this framework looks like, is
[Read a wiring error](/how-to/read-a-wiring-error).

## Two slices, one key: di's own defect, once both are wired in

Nothing in `AmqpHandler` or `TemporalWorkflowActivities` stops two slices from
minting a piece for the same key, and the composing call does not catch it
either: `AmqpHandlers(contract)([...])` / `TemporalActivities(contract)([...])`
are exact against **coverage** — every key has a piece — not against
**injectivity** — no two pieces share one — so an array holding both slices'
pieces for the same key type-checks. A piece's port id carries the contract
key (`` `AmqpHandler:orderNotifications` ``,
`` `TemporalWorkflowActivities:chargeOrder` ``), so two slices both minting a
piece for one key genuinely are two providers on the **same port** — but di's
own duplicate-provider defect only fires once **both** slice modules are
actually imported into one graph and both providers are discharged. Wire in
only one of the two conflicting pieces — pick the wrong slice, or simply never
import the other — and its rival's implementation is unwired with no
diagnostic: nothing, di included, marks that a second implementation for the
key ever existed. The port identity a slice's own port carries is what makes a
caught collision di's defect for free; it is not what guarantees the collision
gets caught.

## What a slice owns

`order-amqp-worker`'s two subscriber slices and `order-temporal-worker`'s two
saga slices land in different places, deliberately: a subscriber reacts to a
fact somebody else already committed, so `NotificationsSlice` and
`AuditSlice` own no domain and no persistence — the vertical stays at the
root, next to the outbox relay that writes it. A workflow orchestrates one,
so `FulfillmentSlice` imports the orders vertical
(`OrderApplicationModule` + `OrderPersistenceModule`) plus `FulfillmentModule`,
and `BillingSlice` imports `BillingModule` alone — two different verticals,
meeting only in the root's `imports` list, never inside either slice's own
graph. Neither shape is weaker than the other: a slice owns as much as its
transport gives it to own.

## See also

- [Split a router into controllers](/how-to/split-a-router-into-controllers) —
  the same idea over a nested contract, where a piece's path can go more than
  one level deep.
- [`@btravstack/amqp-worker`](/reference/amqp-worker) — `AmqpHandler`'s and
  `AmqpHandlers`'s full signatures.
- [`@btravstack/temporal-worker`](/reference/temporal-worker) —
  `TemporalWorkflowActivities`'s and `TemporalActivities`'s full signatures.
- [Order AMQP worker](/examples/order-amqp-worker) and
  [Order Temporal worker](/examples/order-temporal-worker) — the workers
  these samples come from.
