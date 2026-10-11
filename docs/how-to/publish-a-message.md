---
title: Publish a message
description: "Broadcast a committed fact over AMQP — why the write and the row go in one transaction, how @btravstack/outbox's relay gets them out, and what at-least-once costs a subscriber."
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { TypedAmqpClient } from "@amqp-contract/client";
import { Module, Port, Provider } from "@btravstack/di";
import { OrderDatabase, decodeOrderPayload } from "@btravstack/example-order-infrastructure";
import type { AsyncResult } from "unthrown";
import { orderContract } from "@btravstack/example-order-amqp-contract";

// The client, a resourceful provider of the deployment's own — see
// /examples/order-amqp-worker for its acquire and release.
class OrderAmqpClient extends Port("OrderAmqpClient")<TypedAmqpClient<typeof orderContract>> {}

// The deployment's modules that provide the two, as /examples/order-amqp-worker composes them.
declare const OrderPersistenceModule: Module<InstanceType<typeof OrderDatabase>, never, never>;
declare const OrderAmqpClientModule: Module<OrderAmqpClient, never, never>;
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
    const placed = await tx.orm.orders.Order.create({
      tenantId,
      orderId: order.id,
      quantity: order.quantity,
    });
    await tx.orm.orders.OutboxMessage.create({
      tenantId,
      kind: "order",
      subjectId: order.id,
      // `{ placedAt, placementId, order }` — the payload is the application's own encoding
      payload: orderPayload(placed, { quantity: order.quantity }),
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
        .map(() => decodeOrderPayload(message.payload))
        .flatMap(({ placedAt, placementId, order }) =>
          client.publish("orderChanged", {
            eventId: message.id,
            tenantId: message.tenantId,
            kind: message.kind as "order",
            id: message.subjectId,
            occurredAt: message.occurredAt.toISOString(),
            placedAt,
            placementId,
            payload: order,
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
re-publishes on the next claim, and so does a claiming session the database
ends mid-batch. A subscriber therefore has to be idempotent, keyed by
`eventId` — which it has to be anyway, since a broker redelivers an un-acked
message.

**Replicas take turns.** Every replica of the deployment runs a relay over the
same table, and a tenant is held by one of them while its claiming session
lives — a transaction-scoped advisory lock, skipped rather than waited on by
the rest — so replicas do not race for the same rows.

**A refusal holds its tenant.** Any `Err` from `publish` leaves the row
pending and stops that tenant's batch, so a later fact never overtakes it;
the relay backs off and tries again. A payload the contract will refuse on
every attempt therefore blocks its tenant, and the `outbox` component of
`/healthz` goes unhealthy, naming it, once its oldest pending row is older than
`OUTBOX_MAX_LAG_MS`. Whether such a row is dropped is the publisher's call: it
answers `Ok` for a row it decides to park, and the relay marks it — see
[A message that will never go out](#a-message-that-will-never-go-out).

**Order is per tenant, and then only as far as one queue and one consumer.**
The claim publishes a tenant's committed facts in outbox order, one relay at a
time. Outbox order is not commit order — an id still in an open transaction
surfaces after a higher one that committed — so a subject's order rests on its
writes conflicting on its own row, with the outbox row written after the
statement that takes it. AMQP orders
messages within a queue, so what a subscriber sees in order is what arrived on
**its** queue and was consumed sequentially — a prefetch above one with
concurrent handlers gives that up, and so does a second queue. Using one
routing key for every change to a subject is what keeps its create and its
tombstone on the same queue in the first place; routing them separately would
put them on two, with no order between them at all.

The relay is the one caller with no request, delivery or activity behind it,
so its tenants come from configuration — `OUTBOX_TENANTS` — rather than an
ambient record. Each tenant keeps its own schedule, and at most
`OUTBOX_CONCURRENCY` of them (default `4`) hold a claim at once, taking turns
batch by batch so one tenant's backlog cannot starve another's — a claim holds
a pooled connection for its batch, and the bound is what leaves the rest of
the pool to the publisher.

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

## A message that will never go out

A refusal holds its tenant because the tenant's order is the point, so a
message that can never go out holds it forever. Only the publisher knows which
of its refusals are final — here, a payload the contract refuses will be
refused on every attempt, while a broker that refused may not be next time.
For the final kind, record the message where the application keeps its dead
letters and answer `Ok`:

```ts
import type { OutboxMessage } from "@btravstack/outbox";
import { ErrAsync, P } from "unthrown";

class DeadLetters extends Port("DeadLetters")<{
  readonly record: (message: OutboxMessage, reason: string) => AsyncResult<void, never>;
}> {}

const parkingPublisher = Provider(OutboxPublisher)({
  inject: { client: OrderAmqpClient, deadLetters: DeadLetters },
  sync: ({ client, deadLetters }) => ({
    publish: (message) =>
      OkAsync()
        .map(() => decodeOrderPayload(message.payload))
        .flatMap(({ placedAt, placementId, order }) =>
          client.publish("orderChanged", {
            eventId: message.id,
            tenantId: message.tenantId,
            kind: message.kind as "order",
            id: message.subjectId,
            occurredAt: message.occurredAt.toISOString(),
            placedAt,
            placementId,
            payload: order,
          }),
        )
        // Parked and answered `Ok`, so the relay marks it; a broker's refusal stays an `Err`.
        .flatMapErrCases((matcher) =>
          matcher
            .with(P.tag("@amqp-contract/MessageValidationError"), (refused) =>
              deadLetters.record(message, refused.message),
            )
            .with(P.tag("@amqp-contract/PublishError"), (failed) => ErrAsync(failed)),
        ),
  }),
});
```

The relay marks it published and the tenant moves on. What that costs is the
subject's story: the later facts about it now go out without this one, so a
subscriber can see an update for a create it never received. Replaying the
dead letter is a decision somebody makes, knowing that. The relay keeps no
attempt counter that would make it for you — the reasons are on
[the reference page](/reference/outbox#a-message-that-will-never-go-out).

## Carry the trace id to the subscriber

The relay publishes outside any unit, so on its own the delivery that reaches
a subscriber starts a trace of its own. The row is what crosses the gap: the
adapter that writes it runs inside the request's unit, and an infrastructure
adapter reading `currentUnit()` is exactly what the ambient record is for. Put
the trace id into the payload, in the same transaction:

<!-- doctest: skip — an excerpt of an adapter's transaction; the ORM accessor is typed by the application's emitted contract -->

```ts
await tx.orm.orders.OutboxMessage.create({
  tenantId,
  kind: "order",
  subjectId: order.id,
  payload: JSON.stringify({ placedAt, placementId, order, traceId: currentUnit()?.traceId }),
});
```

and have the publisher put it where
[`@btravstack/amqp-worker`](/reference/amqp-worker) adopts a delivery's trace
id from. It reads the trace-id field of a W3C `traceparent` header, else the
message's `messageId`. The request's trace id is a W3C one only when the
request arrived with a `traceparent`; otherwise it is the `x-request-id` it
carried or a minted UUID, which no `traceparent` can hold. `messageId` takes
any of them:

```ts
type Traced = { readonly traceId?: string };

const tracedPublisher = Provider(OutboxPublisher)({
  inject: { client: OrderAmqpClient },
  sync: ({ client }) => ({
    publish: (message) =>
      OkAsync()
        .map(() => decodeOrderPayload(message.payload) as ReturnType<typeof decodeOrderPayload> & Traced)
        .flatMap(({ placedAt, placementId, order, traceId }) =>
          client.publish(
            "orderChanged",
            {
              eventId: message.id,
              tenantId: message.tenantId,
              kind: message.kind as "order",
              id: message.subjectId,
              occurredAt: message.occurredAt.toISOString(),
              placedAt,
              placementId,
              payload: order,
            },
            traceId === undefined ? {} : { messageId: traceId },
          ),
        ),
  }),
});
```

The subscriber's unit then logs under the request's trace id, so one id finds
the request, the row and the handler. What crosses is that correlation id and
nothing more: the relay's publish span is not made a child or a link of the
request's span, for the reason `@btravstack/observability` correlates by
attribute rather than by a parent-child edge it cannot prove.

## Where the relay runs

**In a process you already run.** Compose `outbox()` into the API or the
consumer deployment, as above: every replica runs a relay, and the claim makes
them take turns per tenant. The kernel serves `/livez`, `/readyz` and
`/healthz` on the probe port whatever the runtime is, so the relay's lag
check is on `/healthz` with nothing more to wire, and the relay stops in the
application scope's teardown, after the runtime has drained.

**A process that runs only the relay** needs a runtime too — `runMain` boots
one — and the one it needs does nothing but hold the process open. Nothing
else does: the probe server and the relay's sleep are both unreferenced, so
without a referenced handle the event loop empties, `runMain`'s top-level
`await` never settles, and Node exits `13`. A pooled database connection may
hold the loop for a while, until the pool reaps it as idle, which is not
something to stand a process on. Following
[Write a runtime](/how-to/write-a-runtime), it is one timer, cleared on `stop`:

```ts
import { RuntimePort, runMain, type Runtime } from "@btravstack/core";

class Background extends RuntimePort<Runtime> {}

const background: Runtime = {
  name: "background",
  resolves: [],
  start: () => {
    const alive = setInterval(() => {}, 2 ** 30);
    return OkAsync({
      drain: () => OkAsync(),
      stop: () => {
        clearInterval(alive);
        return OkAsync();
      },
    });
  },
};

export const RelayProcess = Module("RelayProcess")({
  imports: [OrderPersistenceModule, OrderAmqpClientModule, Producer],
  provides: [Provider(Background)({ inject: {}, value: background })],
  exports: [Background],
});

await runMain(RelayProcess);
```

Set `PRE_DRAIN_DELAY_MS=0` on that deployment. The pre-drain delay waits out
a Service's endpoint removal, and a relay is behind no Service; with no units
of its own to drain, it goes straight to teardown, which waits for the batches
in flight.

## Where to go next

- The other half: [Consume AMQP messages](/how-to/consume-amqp-messages).
- The whole thing running against a real broker:
  [Order AMQP worker](/examples/order-amqp-worker).
- The relay's options, the table's shape and the claim:
  [`@btravstack/outbox`](/reference/outbox).
- `acquire`/`release`, as the relay uses it:
  [Manage a resource's lifetime](/how-to/manage-a-resource).
