---
title: Publish a message
description: "Broadcast a committed fact over AMQP — why the write and the row go in one transaction, how a relay gets them out, and what at-least-once costs a subscriber."
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { TypedAmqpClient } from "@amqp-contract/client";
import { AmqpConfig } from "@btravstack/amqp-worker";
import { Config, Env } from "@btravstack/config";
import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";
import { orderContract } from "@btravstack/example-order-amqp-contract";

type TenantId = string;
type OutboxEvent = {
  readonly id: number;
  readonly tenantId: string;
  readonly kind: "order";
  readonly subjectId: string;
  readonly occurredAt: Date;
  readonly payload: { readonly quantity: number } | null;
};
class Outbox extends Port("Outbox")<{
  readonly pending: (tenantId: TenantId, limit: number) => AsyncResult<readonly OutboxEvent[], never>;
  readonly markPublished: (ids: readonly number[]) => AsyncResult<void, never>;
}> {}
class RelayStopped extends TaggedError("RelayStopped")<{ readonly reason: string }> {}
class OutboxRelay extends Port("OutboxRelay")<{ readonly stop: () => AsyncResult<void, never> }> {}
declare const startRelay: (
  url: string,
  pollMs: number,
) => AsyncResult<{ readonly stop: () => AsyncResult<void, never> }, RelayStopped>;
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
table in the same database:

```ts
// In the repository adapter, not in the domain:
//
//   db.$tryTransaction(async (tx) => {
//     await tx.order.create({ data: order });
//     await tx.outbox.create({ data: { tenantId, kind: "order", subjectId: order.id, … } });
//   });
//
// Both rows commit or neither does — the database already guarantees that.
export const OutboxPort = Outbox;
```

Now there is one fact, in one place, and the broadcast is a **separate,
retryable** step: read pending rows, publish them, mark them published.

## The relay, as a resource of the graph

The producer is not a runtime — a graph holds exactly one of those, and this
process's is the consumer or the API. It is an ordinary resourceful provider,
started as the graph builds and stopped when the application scope closes:

```ts
export const relayConfig = Config.provider("RelayConfig")(
  Config.object({
    pollMs: Config.integer("OUTBOX_POLL_MS", { min: 1, max: 60_000, default: 200 }),
  }),
);

export const outboxRelay = Provider(OutboxRelay)({
  // `AmqpConfig` is the starter's own — the relay publishes to the broker this
  // process already consumes from, rather than to a URL of its own that a
  // deployment would have to remember to set twice.
  inject: { broker: AmqpConfig, config: relayConfig.port },
  acquire: ({ broker, config }) => startRelay(broker.url, config.pollMs),
  release: (running) => running.stop().get(),
});
```

Stopping **after** the consumer stops is the right order: rows published during
the drain window are safer out than left to the next boot. And a broker it
cannot reach at startup is a modeled error on `acquire`, so it is a startup
`Err` and exit `1` — an operator can act on that.

## The sweep

```ts
/** One event out, and the row marked only if it went. */
const relay = (
  client: TypedAmqpClient<typeof orderContract>,
  outbox: {
    readonly markPublished: (ids: readonly number[]) => AsyncResult<void, never>;
  },
  event: OutboxEvent,
): AsyncResult<void, never> =>
  client
    .publish("orderChanged", {
      kind: event.kind,
      id: event.subjectId,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
      tenantId: event.tenantId,
    })
    .flatMap(() => outbox.markPublished([event.id]))
    // A row that does not fit the contract can NEVER be published: retrying it
    // every sweep is a poison row burning the batch forever. Park it — log it,
    // and mark it so the sweep stops seeing it — which is the one case where
    // "leave it pending" is the wrong answer.
    .recoverErrCases((matcher) =>
      matcher.with({ _tag: "@amqp-contract/MessageValidationError" }, () => undefined),
    )
    // A broker that refused is a different story: the row stays pending and
    // the next sweep takes it, which is why this arm marks nothing.
    .recoverDefect(() => OkAsync());
```

A sweep is that, over `outbox.pending(tenantId, batch)`, in order — and then
sleeping `pollMs`. The real one batches its `markPublished` rather than calling
it per event; the shape is the same.

Three properties worth naming, because a subscriber has to live with them:

**At-least-once, deliberately.** A crash between `publish` and `markPublished`
re-publishes on the next sweep. A subscriber therefore has to be idempotent —
which it has to be anyway, since a broker redelivers an un-acked message.

**A permanent failure is parked, not retried.** A payload the contract refuses
will be refused on every sweep, so it is logged and marked rather than left
pending; only a _transient_ failure — a broker that was not there — earns the
next sweep.

**Order is per subject, and only as far as one queue and one consumer.** AMQP
orders messages within a queue, so what a subscriber sees in order is what
arrived on **its** queue and was consumed sequentially — a prefetch above one
with concurrent handlers gives that up, and so does a second queue. Using one
routing key for every change to a subject is what keeps its create and its
tombstone on the same queue in the first place; routing them separately would
put them on two, with no order between them at all.

**Sweep tenant by tenant.** The relay is the one caller with no request,
delivery or activity behind it, so its tenants come from configuration rather
than an ambient record — and going tenant by tenant stops one tenant's backlog
starving another's.

## The contract is where the shape lives

`publish("orderChanged", …)` is checked against the contract: the key, the
payload schema, the exchange and the routing key are all declared once, in a
package a subscriber can take **without** this worker. A payload that does not
fit is a `MessageValidationError` before anything reaches the broker.

```ts
export const Producer = Module("Producer")({
  provides: [relayConfig, outboxRelay],
  exports: [OutboxRelay],
  // `AmqpConfig` comes from the starter this process already composes; `Env`
  // and `Logger` are the root's.
  needs: [Env, Logger, AmqpConfig],
});
```

## Where to go next

- The other half: [Consume AMQP messages](/how-to/consume-amqp-messages).
- The whole thing running against a real broker:
  [Order AMQP worker](/examples/order-amqp-worker).
- `acquire`/`release`, as the relay uses it:
  [Manage a resource's lifetime](/how-to/manage-a-resource).
