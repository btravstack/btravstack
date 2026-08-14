# `@btravstack/core` example: the order AMQP contract

The AMQP contract — one exchange, one change-stream event (`kind`, `id`,
`occurredAt`, `payload`, where a null payload is the **tombstone**), one
subscriber queue with a dead-letter exchange and a retry policy — in a package
of its own, depending on `@amqp-contract/contract` and `zod`.

```
src/contract.ts        the contract: exchange, queue, retry/dead-letter policy, message, publisher, consumer
src/layering.test-d.ts the dependency rule, as a compile error
src/test-fixtures.ts   the contract itself, and its message schema as a validator returning a Result
```

## Why it is not part of `order-amqp-worker`

A contract is a **shared artifact**. Two parties read this file: the worker
whose relay publishes `order.changed` and whose consumer reads
`order-notifications`, and any _other_ service that wants to subscribe to the
broadcast — neither wants a di container, a Prisma-backed repository or the
kernel.

```
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

`defineEventConsumer` derives the queue's binding from the publisher it
consumes, so `defineContract` needs a publisher entry — and here the repo
genuinely ships both sides: `orderChangedEvent` is what the outbox relay
publishes, and the `order-notifications` consumer is one subscriber among
however many bind their own queues to the same exchange.

## The retry budget is contract configuration, not a runtime constant

A hand-rolled worker spells its retry policy as a `MAX_ATTEMPTS` constant and an
`if` in its runtime; here it is `order-notifications`'s `retry` and `deadLetter`
options, which the broker itself enforces — the sharper form of the same claim
the Temporal contract makes with `nonRetryable`: naming a failure decides not
only what the caller sees but what the platform does next.

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
