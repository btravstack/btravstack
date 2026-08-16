---
title: Examples
description: One clean-architecture order application booted under three runtimes — an oRPC API, a Temporal worker and an AMQP consumer — plus the container's own example; all of it compiled and tested as part of the repository's gate.
---

# Examples

Annotated tours of the runnable packages under
[`examples/`](https://github.com/btravstack/start/tree/main/examples). Ten of
them, none published, all of them in the gate: nine model **one order
application, booted three ways**, and the tenth is the container's own.

**Unlike the snippets elsewhere in this guide, this code compiles and is
covered by tests.** The two workers need something the others do not — a
Docker daemon for the AMQP one, network access on a cold cache for the
Temporal one — and each page below says so.

```sh
git clone https://github.com/btravstack/start.git
cd start
pnpm install
pnpm turbo run test --filter="@btravstack/example-*"
pnpm turbo run typecheck --filter="@btravstack/example-*"
```

## The layering

Every arrow points inwards, and the contract tier stands to one side:
depended upon, depending on nothing.

```
  order-api      order-temporal-worker      order-amqp-worker   ← one runtime each; one process each
       └────────────────┼──────────────────┘
                        ▼
             order-infrastructure                    ← Prisma, SQLite, P-codes
                        │  provides OrderRepository
                        ▼
              order-application                     ← use cases, and the ports they declare
                        │
                        ▼
                 order-domain                       ← entities and rules; depends on nothing

  order-api-contract   order-temporal-contract   order-amqp-contract   ← taken by a server AND by any client
```

`order-infrastructure` imports `order-application`, not the other way round:
the port it implements, `OrderRepository`, is declared by the use cases that
need it, in the domain's vocabulary. `ApplicationModule` therefore leaves that
need **unmet** — as a type, not a comment — and `Module.scoped(ApplicationModule, …)`
does not compile until an outer module provides one. Each package boundary
that must not be crossed is pinned by a `layering.test-d.ts` importing the
forbidden package under a `@ts-expect-error`, so adding the dependency makes
the directive unused and fails `pnpm typecheck`.

## One application, three deployments

Every composition root imports the same pair — `ApplicationModule`,
`PersistenceModule` — and nothing in either differs between deployments. What
differs is what each transport is **for**:

- **`order-api`** answers a caller: a request arrives, a typed answer leaves.
- **`order-temporal-worker`** owns a journey: place, reserve, ship, and
  compensation in reverse when a later step answers a permanent no.
- **`order-amqp-worker`** tells everyone what happened: every committed write
  leaves an event through a transactional outbox; nobody is addressed.

The use cases return a `Result`, and what a `Result` means is the transport's
business — the same `Err` becomes a different outcome wherever a caller
exists to hear it:

| unthrown               | `order-api`             | `order-temporal-worker`                 |
| ---------------------- | ----------------------- | --------------------------------------- |
| `Ok(order)`            | the procedure's output  | the workflow's output                   |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | `InvalidQuantity`, **non-retryable**    |
| `Err(DuplicateOrder)`  | `CONFLICT`              | `OrderAlreadyPlaced`, **non-retryable** |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retried by the platform**, then fails |

`order-amqp-worker` has no column: on a broadcast there is no caller waiting
to be told, so a placement's `Err` never crosses the broker — only the
committed fact does, and what its subscriber queue does with a failure is the
queue's own `retry` / dead-letter policy, declared in the contract and
enforced by the broker. The kernel appears in none of the columns either way:
`RunUnit` hands a runtime the work's own `Result` and stays out of what it
means.

The three also disagree about what one **unit** is, and the kernel does not
care:

|                         | one unit is              | `id`                    | `traceId`                         |
| ----------------------- | ------------------------ | ----------------------- | --------------------------------- |
| `order-api`             | one HTTP request         | a fresh `randomUUID()`  | an inbound `x-request-id`, if any |
| `order-temporal-worker` | one **activity attempt** | Temporal's task token   | the workflow id                   |
| `order-amqp-worker`     | one **delivery**         | a minted `randomUUID()` | the publisher's `messageId`       |

## The pages

### [The order application](/examples/order-application)

`order-domain`, `order-application`, `order-infrastructure` and the three
contract packages: an `Entity` with a re-checked invariant and failures as
values, use cases as providers over ports the caller declares, a Prisma
repository over in-memory SQLite translating P-codes into the domain's
vocabulary, the outbox written in the same transaction as the row, and the
two kinds of type test that keep the arrows pointing the right way.

### [Order API (HTTP)](/examples/order-api)

`HttpRouter(orderContract)` — every procedure a plain
`Result`-returning function and one exhaustive `mapErrCases` where a domain
`Err` becomes a typed `ORPCError`; `HttpModule("OrderApi")` as the whole
composition root; `RequestModule` forked per request through
`StartOptions.unit`; a one-line `main.ts`; a spec booting the real module on
`PORT=0`; and a `needs-gate.test-d.ts` pinning three compile-time gates.

### [Order Temporal worker](/examples/order-temporal-worker)

`TemporalActivities` and `TemporalModule`; a fulfillment saga in the
deterministic sandbox with compensation in reverse; the triage that makes a
domain `Err` a `nonRetryable` contract error the client branches on by name;
the time-skipping test server cached at `.cache/temporal-test-server`; and a
drain that honours the kernel's deadline against a worker that keeps its own
clock.

### [Order AMQP worker](/examples/order-amqp-worker)

`AmqpHandlers` and `AmqpModule`; the outbox relay as a resourceful provider
with its own `RelayConfig` and a modeled `BrokerUnreachable`; a tombstone
behind every cancellation; a foreign queue receiving the same event; and a
real RabbitMQ container per run.

### [Hexagonal order API (di alone)](/examples/hexagonal-order-api)

The container alone: a `Module` composed and asserted, never booted — ports
named by the domain, a private connection pool beside a public repository,
and one application built against a production adapter and an in-memory one.
It is also the one workspace that compiles twice, once under the catalog's
TypeScript and once under the stable consumer line.

## Why these are part of the gate

Every fenced block elsewhere in this guide is written by hand and checked by
review. These packages cannot drift: they are workspace packages that
typecheck, whose specs run in CI alongside the kernel's own, and which consume
`@btravstack/core` and the starters through `workspace:*` from a consumer's
own workspace. Nothing is faked at the boundaries that matter — a real Prisma
client raises a real `P2002`, a real `node:http` server carries a real oRPC
call, a real Temporal Worker polls a real task queue, a real broker parks a
real message. If the kernel or a starter changes underneath them, something
goes red.
