---
title: Publish a message
description: "Broadcast a committed fact over AMQP — why the write and the row go in one transaction, how @btravstack/outbox's relay gets them out, and what at-least-once costs a subscriber."
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { TypedAmqpClient } from "@amqp-contract/client";
import { Module, Port, Provider } from "@btravstack/di";
import { OrderDatabase } from "@btravstack/example-order-infrastructure";
import type { AsyncResult } from "unthrown";
import { orderContract } from "@btravstack/example-order-amqp-contract";

// The client, a resourceful provider of the deployment's own — see
// /examples/order-amqp-worker for its acquire and release.
class OrderAmqpClient extends Port("OrderAmqpClient")<TypedAmqpClient<typeof orderContract>> {}
-->

# Publish a message

> **How-to.** Get a fact out to whoever is listening, without the fact and the
> broadcast disagreeing about whether it happened. For the consuming half, see
> [Consume AMQP messages](/how-to/consume-amqp-messages).

**AMQP carries announcements.** What goes on the wire is something that already
committed — past tense, a fact — never a command asking somebody to do
something. A command with a result belongs to
[Temporal](/reference/temporal-worker); an announcement belongs here.

## The problem publishing has

Two writes, no shared transaction:

```ts
// DO NOT: the write and the broadcast can disagree
declare const placeOrder: () => AsyncResult<void, never>;
declare const publishOrderChanged: () => AsyncResult<void, never>;

const racy = (): AsyncResult<void, never> =>
  placeOrder().flatMap(() => publishOrderChanged());
```

The process can die between them. Either the order exists and nobody was told,
or — with the calls the other way round — subscribers act on an order that was
never saved. No amount of retrying fixes it, because the failure is _between_
two systems that cannot agree.

## The outbox: one transaction, one row

Write the event **in the same transaction as the change it describes**, into a
table in the same database. That transaction is the repository adapter's,
spelled at the call — `examples/order-infrastructure`'s
`prismaOrderRepository.save`:

<!-- doctest: skip — an excerpt of examples/order-infrastructure/src/prisma-order-repository.ts, which its own workspace compiles -->

```ts
save: (order) =>
  pinned(async (tx) => {
    await tx.orm.orders.Order.create({ tenantId, orderId: order.id, quantity: order.quantity });
    await tx.orm.orders.OutboxMessage.create({
      tenantId,
      kind: "order",
      subjectId: order.id,
      payload: JSON.stringify({ quantity: order.quantity }),
    });
  }),
```

Both rows commit or neither does — the database already guarantees that. Now
there is one fact, in one place, and the broadcast is a **separate,
retryable** step: claim pending rows, publish them, mark them published. The
table's shape is [`@btravstack/outbox`](/reference/outbox)'s documented one,
declared in the application's own contract.

## The relay, as a resource of the graph

The producer is not a runtime — a graph holds exactly one of those, and this
process's is the consumer or the API. The relay is
[`@btravstack/outbox`](/reference/outbox)'s `outbox()`: a resourceful
provider, started as the graph builds and stopped when the application scope
closes. It owes two ports, and both are yours — where the rows are, and what
publishing one means:

```ts
import { OutboxPublisher, OutboxStore, outbox } from "@btravstack/outbox";
import { prismaOutboxStore } from "@btravstack/outbox/prisma";
import { OkAsync } from "unthrown";

const store = Provider(OutboxStore)({
  inject: { db: OrderDatabase },
  sync: ({ db }) => prismaOutboxStore(db, { schema: "orders" }),
});

const publisher = Provider(OutboxPublisher)({
  inject: { client: OrderAmqpClient },
  sync: ({ client }) => ({
    publish: (message) =>
      OkAsync()
        .map(() =>
          message.payload === null
            ? null
            : (JSON.parse(message.payload) as { readonly quantity: number }),
        )
        .flatMap((payload) =>
          client.publish("orderChanged", {
            tenantId: message.tenantId,
            kind: message.kind as "order",
            id: message.subjectId,
            occurredAt: message.occurredAt.toISOString(),
            payload,
          }),
        ),
  }),
});
```

Stopping **after** the consumer stops is the right order: rows published during
the drain window are safer out than left to the next boot. A broker the client
cannot reach at startup is a modeled error on its `acquire`, so it is a
startup `Err` and exit `1` — an operator can act on that.

Four properties worth naming, because a subscriber has to live with them:

**At-least-once, deliberately.** A crash between a publish and its mark
re-publishes on the next claim. A subscriber therefore has to be idempotent —
which it has to be anyway, since a broker redelivers an un-acked message.

**Never twice at once.** Every replica of the deployment runs a relay over the
same table, and a tenant is claimed by one of them at a time — a
transaction-scoped advisory lock, skipped rather than waited on by the rest —
so the replica count adds no duplicates of its own.

**A refusal holds its tenant.** Any `Err` from `publish` leaves the row
pending and stops that tenant's batch, so a later fact never overtakes it;
the relay backs off and tries again. A payload the contract will refuse on
every attempt therefore blocks its tenant, and the `outbox` component of
`/healthz` goes unhealthy, naming it, once its oldest pending row is older than
`OUTBOX_MAX_LAG_MS`. Whether such a row is dropped is the publisher's call: it
answers `Ok` for a row it decides to park, and the relay marks it.

**Order is per tenant, and then only as far as one queue and one consumer.**
The claim keeps a tenant's facts in commit order across replicas. AMQP orders
messages within a queue, so what a subscriber sees in order is what arrived on
**its** queue and was consumed sequentially — a prefetch above one with
concurrent handlers gives that up, and so does a second queue. Using one
routing key for every change to a subject is what keeps its create and its
tombstone on the same queue in the first place; routing them separately would
put them on two, with no order between them at all.

The relay is the one caller with no request, delivery or activity behind it,
so its tenants come from configuration — `OUTBOX_TENANTS` — rather than an
ambient record, and it sweeps them one by one so one tenant's backlog cannot
starve another's.

## The contract is where the shape lives

`publish("orderChanged", …)` is checked against the contract: the key, the
payload schema, the exchange and the routing key are all declared once, in a
package a subscriber can take **without** this worker. A payload that does not
fit is a `MessageValidationError` before anything reaches the broker.

```ts
export const Producer = Module("Producer")({
  imports: [outbox()],
  provides: [store, publisher],
  exports: [],
  // The client comes from the deployment's own provider, the database from
  // its persistence module; `Env` is outbox()'s and travels with the import.
  needs: [OrderDatabase, OrderAmqpClient],
});
```

## Where to go next

- The other half: [Consume AMQP messages](/how-to/consume-amqp-messages).
- The whole thing running against a real broker:
  [Order AMQP worker](/examples/order-amqp-worker).
- The relay's options, the table's shape and the claim:
  [`@btravstack/outbox`](/reference/outbox).
- `acquire`/`release`, as the relay uses it:
  [Manage a resource's lifetime](/how-to/manage-a-resource).
