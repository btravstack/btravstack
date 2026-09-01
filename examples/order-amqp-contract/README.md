# `@btravstack/core` example: the order AMQP contract

The AMQP contract — one exchange, one change-stream event (`kind`, `id`,
`occurredAt`, `payload`, where a null payload is the **tombstone**), two
subscriber queues (`orderNotifications`, `orderAudit`) each with its own
dead-letter exchange and retry policy — in a package of its own, depending on
`@amqp-contract/contract` and `zod`.

```text
src/contract.ts        the contract: exchange, queue, retry/dead-letter policy, message, publisher, consumer
src/layering.test-d.ts the dependency rule, as a compile error
src/__tests__/test-fixtures.ts   the contract itself, and its message schema as a validator returning a Result
```

## Two consumers of one publisher

`consumers` declares two entries — `orderNotifications`, on the
`order-notifications` queue, and `orderAudit`, on `order-audit` — both
`defineEventConsumer(orderChangedEvent, …)`, both reading the same broadcast.
The keys name the **subscriber**, not the event: two readers of one fact, not
two facts. That is what makes this a broadcast rather than a work queue —
`defineContract`'s own routability check accepts two queues bound to the same
exchange because neither subscriber knows the other exists, each keeps its
own retry budget and dead-letter exchange, and one slow reader cannot stall
the other. A third service binding a third queue to `orders` needs nothing
from this file changed either; that is the property the worker's own specs
prove by doing exactly that with a queue this contract never declared.

## Why it is not part of `order-amqp-worker`

A contract is a **shared artifact**. Several parties read this file: the
worker whose relay publishes `order.changed` and whose two slices read
`order-notifications` and `order-audit`, and any _other_ service that wants
to subscribe to the broadcast — none of them wants a di container, a
Prisma-backed repository or the kernel.

```text
   order-amqp-worker          any subscriber to order.changed
         └──────────┬──────────┘
                    ▼
       order-amqp-contract     ← @amqp-contract/contract and zod, nothing else
```

`src/layering.test-d.ts` is that sentence as a compile error: it imports
`@btravstack/example-order-amqp-worker` under a `@ts-expect-error`, so the day
this package gains a dependency on the worker it describes, `test:types` fails
because the directive stops being used.

## A publisher entry is structurally required

`defineEventConsumer` derives a queue's binding from the publisher it
consumes, so `defineContract` needs a publisher entry — and here the repo
genuinely ships both sides: `orderChangedEvent` is what the outbox relay
publishes, and `orderNotifications` / `orderAudit` are two subscribers among
however many bind their own queues to the same exchange.

## The retry budget is contract configuration, not a runtime constant

A hand-rolled worker spells its retry policy as a `MAX_ATTEMPTS` constant and an
`if` in its runtime; here it is each queue's own `retry` and `deadLetter`
options — `order-notifications` and `order-audit` currently carry the same
values, but nothing requires that; a slower or more critical subscriber could
tune its own independently — which the broker itself enforces: the sharper
form of the same claim the Temporal contract makes with `nonRetryable`,
naming a failure decides not only what the caller sees but what the platform
does next.

`orders-dlx` carries `externalConsumers: true` because nothing in this
contract binds a queue to it: `defineContract` runs a define-time
routability check that otherwise rejects a dead-letter exchange nothing
consumes, on the same reasoning it rejects an unroutable publish — messages
routed to a queue nothing reads from are silently lost. Parking is the point
here, so the flag says that deliberately rather than leaving a reader to
wonder why the check did not fire.

## The schema is the demonstration

Where the oRPC contract's proof is a client built from it, this one's is that
the contract is **executable**: `src/contract.spec.ts` runs the event
message's own payload schema through `@unthrown/standard-schema`'s
`fromSchema` and gets a `Result`, with no worker, no connection and no broker
in scope — which is exactly the check a publisher makes before sending a
message.

`zod` is a runtime dependency because the schema **is** the contract — it
travels to the publisher, which validates against it. `unthrown` is a dev
dependency only: `@unthrown/vitest` peers on it, so it keeps one copy of it
across the workspace and backs the spec's matchers.
