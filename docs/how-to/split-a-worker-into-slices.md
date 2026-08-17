---
title: Split a worker into slices
description: Give each consumer or workflow its own slice, and compose them into one handlers or activities record with AmqpHandler or TemporalWorkflowActivities.
---

# Split a worker into slices

> **How-to.** For an AMQP consumer or a Temporal worker that has outgrown one
> `AmqpHandlers(contract)(deps, arm)` or `TemporalActivities(contract)(deps, arm)`.
> For the single-record shape, see
> [Consume AMQP messages](/how-to/consume-amqp-messages) and
> [Run a Temporal worker](/how-to/run-a-temporal-worker).

`AmqpHandlers(contract)(deps, arm)` and `TemporalActivities(contract)(deps,
arm)` put every consumer's or every workflow's implementation in one
function — right for a worker with one or two of them, wrong once a worker
grows enough consumers or workflows that one function means one slice's typo
failing the whole record's type-check. A **piece** is the fix: one consumer or
one workflow as an ordinary di provider, minted its own port from the
contract key, composed by the root into an array. Everything below is lifted
from `examples/order-amqp-worker` (two subscriber slices) and
`examples/order-temporal-worker` (two saga slices).

## Why a worker's record is not nested like a router's

[Split a router into controllers](/how-to/split-a-router-into-controllers)
starts from a contract that is already nested — `{ orders: {...}, customers:
{...} }` — so a slice's fragment is a sub-object and the root composes a
**record**, one controller per top-level key, with `HttpRouter(contract)({
orders: ordersController, customers: customersController })`. An
`amqp-contract` or `temporal-contract` contract has no such nesting: its
consumers and its workflows are already flat top-level keys of one contract,
not fragments of it. There is nothing to key a nested composition by, so the
worker starters compose an **array** instead — `AmqpHandlers(contract)([...])`
/ `TemporalActivities(contract)([...])` — and reach the same exactness a
different way: each piece's port id carries the contract key it targets, so
the array itself needs no keys at all. Two forms, one property: a slice owns
exactly one key, and the composing call is exact against every key the
contract declares.

## Step 1 — a piece per consumer or per workflow

`AmqpHandler(contract, key)` and `TemporalWorkflowActivities(contract, key)`
are `AmqpHandlers(contract)` / `TemporalActivities(contract)`'s own shape,
aimed at one key: the first call fixes the key's type and mints a port under
it — there is no name to give, since the contract key **is** the port's
name — and the second is di's own `Provider(port)(deps, { sync })`, so
`sync`'s return is typed by that one key alone. A handler or an activity
record whose message or input has drifted is a compile error inside the
piece's own file, not at the root:

```ts
// slices/notifications/handler.ts
export const orderNotifications = AmqpHandler(
  orderContract,
  "orderNotifications",
)([Logger], {
  sync: (logger) => (message) => {
    const { id, payload } = message.payload;
    logger.info(
      payload === null ? "order gone — notifying" : "order placed — notifying",
      {
        orderId: id,
      },
    );
    return OkAsync();
  },
});
```

```ts
// slices/billing/activities.ts
export const chargeOrder = TemporalWorkflowActivities(
  orderContract,
  "chargeOrder",
)([PaymentService], {
  sync: (payments) => ({
    authorizePayment: (args, { errors }) =>
      payments
        .authorize(args.orderId, args.amount)
        .map((authorizationId) => ({ authorizationId }))
        .mapErrCases((matcher) =>
          matcher.with(P.tag("PaymentDeclined"), (error) =>
            errors.PaymentDeclined({ id: error.id }),
          ),
        ),
    capturePayment: (args) => payments.capture(args.authorizationId),
    refundPayment: (args) => payments.refund(args.authorizationId),
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
  provides: [orderNotifications],
  exports: [orderNotifications],
});

export const BillingSlice = Module("BillingSlice")({
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

export const orderActivities = TemporalActivities(orderContract)([
  fulfillOrder,
  chargeOrder,
]);
```

Di constructs every piece first — they are the composed provider's own
`deps`, in array order — and this reassembles the record from them, keyed by
what each piece's port id carries. The composed provider's own `deps` are the
**pieces' ports**, not what a piece closes over, so a piece still needs
discharging like any other need: the root **imports every slice module**,
even though nothing in it names a piece directly —

```ts
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    observability(),
  ],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
```

Dropping a slice's import here would leave its piece's port unmet — a runtime
`WiringDefect` naming it, not a compile error, since `AmqpHandlers`/
`TemporalActivities` cannot see what a slice's module has or has not been
imported by; only `start` can.

## What a mistake looks like at compile time

Two mistakes are caught before the array is ever composed, both inside
`AmqpHandler(contract, key)` / `TemporalWorkflowActivities(contract, key)`'s
own call:

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
key the contract declares: an array missing one is refused, and the
diagnostic names what is missing rather than failing silently or merging
`undefined` into the record:

```ts
// @ts-expect-error -- the "orderAudit" consumer is uncovered
AmqpHandlers(orderContract)([orderNotifications]);

// @ts-expect-error -- the "fulfillOrder" key is uncovered
TemporalActivities(orderContract)([chargeOrder]);
```

The first names the missing key as `readonly ["UNCOVERED HANDLERS",
"orderAudit"]`, the second as `readonly ["UNCOVERED ACTIVITIES",
"fulfillOrder"]` — both refused at the call, and both readable straight off
the type error rather than a runtime stack trace.

This is why the composing arm is declared **last** in the intersection both
packages build it from — di's builder first, the composer last — so
TypeScript reports the composer's own failure and the diagnostic names the
missing key rather than degrading to di's generic `Qualification`, which
names nothing.

## Two slices, one key: di's own defect, for free

A key the contract declares is claimed by exactly one piece — nothing in
`AmqpHandler` or `TemporalWorkflowActivities` enforces that directly, and
nothing has to. A piece's port id carries the contract key
(`` `AmqpHandler:orderNotifications` ``, `` `TemporalWorkflowActivities:chargeOrder` ``),
so two slices both minting a piece for one key are two providers on the
**same port**: di's own duplicate-provider defect at build, the moment both
slice modules are imported into one graph. There is no second mechanism to
maintain here — the port identity a slice's own port already carries is what
makes "a workflow's activities belong to exactly one slice" true.

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
  the same idea over a nested contract, composing a keyed record instead of
  an array.
- [`@btravstack/amqp`](/reference/amqp) — `AmqpHandler`'s and
  `AmqpHandlers`'s full signatures.
- [`@btravstack/temporal`](/reference/temporal) —
  `TemporalWorkflowActivities`'s and `TemporalActivities`'s full signatures.
- [Order AMQP worker](/examples/order-amqp-worker) and
  [Order Temporal worker](/examples/order-temporal-worker) — the workers
  these samples come from.
