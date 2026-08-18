# Examples

Ten small packages, none of them published, all of them in the gate.

The **`order-*` nine** are one application booted three ways: a clean
architecture split across four layers, deployed once as an oRPC API, once as a
Temporal worker and once as an AMQP consumer, with each transport's contract in a
package of its own — and, at the same time, exercising `@btravstack/core` end to
end from a consumer's own workspace, `workspace:*` and all.

The **tenth**, [`hexagonal-order-api`](#the-containers-one), came with
`@btravstack/di` and is the container's own: it composes a `Module` and never
calls `start`.

| Package                                                | Layer     | Shows                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`order-domain`](./order-domain)                       | domain    | Entities and rules with no dependencies at all: branded fields, an `Entity.invariant` re-checked on every path, failures as values.                                                                   |
| [`order-application`](./order-application)             | use cases | Ports declared by the caller, interactors, and one module per vertical whose repository — and, for orders, `Logger` — is deliberately an **unmet need**.                                              |
| [`order-infrastructure`](./order-infrastructure)       | adapters  | Prisma-backed repositories over a multi-tenant PostgreSQL schema, translating P-codes into the domain's vocabulary and closing the application's repository needs.                                    |
| [`order-api-contract`](./order-api-contract)           | contract  | The oRPC contract on its own — wire shapes and declared error codes — taken by the server that implements it **and** by any client.                                                                   |
| [`order-api`](./order-api)                             | runtime   | The first deployment: a two-slice modulith — a controller per contract fragment, composed into one oRPC router — served by `http()`, and `Result` → `ORPCError`.                                      |
| [`order-temporal-contract`](./order-temporal-contract) | contract  | The Temporal contract on its own — two workflows, eight activities, five declared `nonRetryable` errors — read by the worker, the sandbox and the client.                                             |
| [`order-temporal-worker`](./order-temporal-worker)     | runtime   | The **orchestration** deployment: two saga slices on `@btravstack/temporal` — `fulfillOrder` places, reserves and ships with compensation in reverse; `chargeOrder` authorizes and refunds a payment. |
| [`order-amqp-contract`](./order-amqp-contract)         | contract  | The AMQP contract on its own — one exchange, one event, two subscriber queues each with its own retry/dead-letter policy — read by the relay and by any subscriber.                                   |
| [`order-amqp-worker`](./order-amqp-worker)             | runtime   | The **broadcast** deployment: two subscriber slices over a transactional outbox relayed onto RabbitMQ by `@btravstack/amqp`'s worker — every committed write becomes an event.                        |

## The layering, and which way the arrows point

```
  order-api      order-temporal-worker      order-amqp-worker   ← one runtime each; one process each
       └────────────────┼──────────────────┘  ─────▶ Config (the kernel's)  ← how all three read the environment
                        ▼
             order-infrastructure                    ← Prisma, PostgreSQL, P-codes
                        │  provides OrderRepository
                        ▼
              order-application                     ← use cases, and the ports they declare
                        │
                        ▼
                 order-domain                       ← entities and rules; depends on nothing
```

Every arrow points **inwards**, and the one that looks like it goes the wrong
way is the whole idea: `order-infrastructure` imports `order-application`,
because the port it implements — `OrderRepository`, spelled in the domain's
vocabulary — is declared by the caller that needs it, not by the database that
happens to satisfy it. `OrderApplicationModule` therefore leaves that need
**unmet**, which is not documentation but a type:
`Module.scoped(OrderApplicationModule, …)` does not compile until an outer
module provides one. There is one such module per vertical, so the gate names
the repository that vertical actually uses.

## The contract tier, which depends on nothing and is depended upon

A transport's contract is a **shared artifact**, so each one is a package of its
own:

```
   order-api      any API client        order-temporal-worker   any workflow client        order-amqp-worker     any publisher
       └──────────────┬───────┘              └───────────────┬───────┘                  └────────────┬────────┘
                      ▼                                      ▼                                        ▼
            order-api-contract                    order-temporal-contract                    order-amqp-contract
            ← @orpc/contract                      ← @temporal-contract/contract, zod         ← @amqp-contract/contract, zod
```

Every arrow points _at_ a contract and none points out of one. That is the whole
of contract-first design: a client is entitled to the wire shapes and the
declared errors without the router or activity that implements them, the di
wiring behind it, the Prisma-backed repository behind that, or the kernel
booting the lot. The api and temporal contracts sat inside
`order-api/src/contract.ts` and `order-temporal-worker/src/contract.ts` before being
extracted, so no client could take one without the others until then;
`order-amqp-contract` started as its own package from the outset, the same
shape without the detour. None of the three depends on `@btravstack/core`, on
`@btravstack/di`, or on any other example — the transports depend on **them**.

The rule is enforced by the compiler rather than by review: each contract
package's `src/layering.test-d.ts` imports its transport package under a
`@ts-expect-error`, so adding the implementation to the contract's dependencies
makes the directive unused and fails `test:types` — the same shape
`order-domain` uses to keep the application layer out of the domain.

And the payoff is demonstrated rather than asserted. `order-api-contract`'s own
spec builds a real oRPC client from `RouterContractClient<typeof contract>`
and drives it over a stub `fetch`, with nothing from `order-api` in scope;
`order-temporal-contract`'s runs the workflow's input schema as a validator
returning a `Result`, which is the check a caller makes before starting an
execution — all a Temporal client can do without a running service.
`order-amqp-contract`'s runs the placement message's own payload schema the
same way, with no worker, no connection and no broker in scope — the check a
publisher makes before sending a message.

## One application, three deployments — each doing what its transport is for

Every deployment composes the same pair — `OrderApplicationModule`,
`OrderPersistenceModule` — and nothing in either differs between them, though
not always at the same level: `order-api`'s root and `order-amqp-worker`'s
root import the pair directly (the relay owns the outbox vertical, and
neither of `order-amqp-worker`'s subscriber slices owns any vertical at all),
while `order-temporal-worker`'s `FulfillmentSlice` imports it instead — the
orders vertical is `fulfillOrder`'s alone there, and `chargeOrder`'s
`BillingSlice` carries a different one, `BillingModule`, instead. The
customers vertical is a separate pair of modules everywhere, so a deployment
that never answers a customer question does not carry its use case or its
repository. What differs is what each transport is **for**:

- **`order-api`** answers a caller: a request arrives, a typed answer leaves.
- **`order-temporal-worker`** owns two journeys: the fulfillment saga runs
  steps in order and compensates in reverse when one answers a permanent no;
  the billing saga authorizes and captures a payment, refunding it on
  failure — orchestration, which needs a durable owner.
- **`order-amqp-worker`** tells everyone what happened: every committed write
  leaves an event through a transactional outbox — and a cancellation leaves
  a tombstone — broadcast, which needs no addressee at all.

The use cases return a `Result`, and what a `Result` means to a transport is
the transport's business — **the same `Err` becomes different outcomes** where
a caller exists to hear it:

| unthrown               | `order-api`             | `order-temporal-worker`                 |
| ---------------------- | ----------------------- | --------------------------------------- |
| `Ok(order)`            | the procedure's output  | the workflow's output                   |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | `InvalidQuantity`, **non-retryable**    |
| `Err(DuplicateOrder)`  | `CONFLICT`              | `OrderAlreadyPlaced`, **non-retryable** |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retried by the platform**, then fails |

`order-amqp-worker` is deliberately absent from that table: on a broadcast
there is no caller waiting to be told, so a placement's `Err` never crosses the
broker — only the committed fact does. The kernel appears in none of the
columns either way. `RunUnit` hands a runtime the work's own `Result` and stays
out of what it means.

The fourth and fifth columns carry something the second and third do not.
Naming a failure on a Temporal contract decides not only what the caller sees
but **whether the platform retries it** — both domain errors are declared
`nonRetryable`, so Temporal asks exactly once, while an unmodelled failure
stays unnamed and the retry policy takes over. A hand-rolled worker spells that
distinction as an attempt budget; on Temporal it is a line of contract, and
on AMQP it is too, in the broker's own vocabulary: `order-notifications`'s
`retry: { mode: "ttl-backoff", maxRetries: 3 }` is contract configuration the
broker itself enforces, not a runtime constant. The count means something
different, though — `maxRetries: 3` is retries **on top of** the first
attempt, so an unmodelled failure is attempted **four** times in total before
it is parked, not the three `maximumAttempts: 3` names on Temporal.

## What each runtime calls a "unit"

The three deployments disagree about what one piece of work is, and the kernel
does not care — which is the point of `RunUnit` being parameterised by nothing
but `UnitMeta`:

|                         | one unit is              | `id`                    | `traceId`                         |
| ----------------------- | ------------------------ | ----------------------- | --------------------------------- |
| `order-api`             | one HTTP request         | a fresh `randomUUID()`  | an inbound `x-request-id`, if any |
| `order-temporal-worker` | one **activity attempt** | Temporal's task token   | the workflow id                   |
| `order-amqp-worker`     | one **delivery**         | a minted `randomUUID()` | the publisher's `messageId`       |

All three are answering the same obligation — `UnitMeta.id` must be unique per
unit, because `traceId` defaults to it — and all three land on "the attempt, not
the logical thing", because a retry is a second unit and the same trace.
`order-amqp-worker` mints its `id` rather than reusing the broker's: a delivery
tag is not unique per attempt (see
[`@btravstack/amqp`'s README](../packages/amqp/README.md) for why), where a
queue job id or a task token already is.

## What each runtime needs, and how the gate sees it

A runtime is a service the composition root exports, on a port each starter
ships over the kernel's `RuntimePort` (`HttpRuntime`, `TemporalRuntime`,
`AmqpRuntime`), and every application-specific thing a runtime used to
resolve is now a **port its provider depends on** through di — the starter's
own fixed port, provided with the starter's own sugar and never named (a
process serves one router / activities record / handlers record as it boots
one runtime): `order-api`'s `orderRouter = HttpRouter(contract)({ orders:
ordersController, customers: customersController })`, a **slice's controller
per top-level contract key** (below); `order-temporal-worker`'s `orderActivities =
TemporalActivities(orderContract)([fulfillOrder, chargeOrder])`, one
`TemporalWorkflowActivities` piece per saga slice; `order-amqp-worker`'s
`orderHandlers = AmqpHandlers(orderContract)([orderNotifications, orderAudit])`,
one `AmqpHandler` piece per subscriber slice — di's own
`Provider(port)(deps, arm)` on that port either way, typed by the
contract, and each composition root the matching `HttpModule` / `TemporalModule` /
`AmqpModule` taking the provider. A worker's record has no nesting to key a
`HttpRouter`-shaped composition by, so each piece's port id carries the
contract key instead, and the starter composes an **array** rather than a
record — the same exactness (every key covered, two slices claiming one key
is di's duplicate-provider defect at build) reached a different way. No
starter
declares a `needs` any more — all three runtimes are `Runtime<never, Info>`
— so `start`'s `UNSATISFIED RUNTIME NEEDS` arm is exercised only by the
kernel's own type test now; what the examples pin is the other two gates.

Pinned in `order-api/src/needs-gate.test-d.ts`,
`order-temporal-worker/src/needs-gate.test-d.ts` and
`order-amqp-worker/src/needs-gate.test-d.ts`: the wired call is an ordinary
one; a composition that forgets its starter fails on **arity** with
`NO RUNTIME`; and a composition that imports the starter without providing its
router / activities / handlers port fails at `start` — di's own
`UNSATISFIED DEPENDENCIES` gate, since the runtime provider depends on that
port. `order-api` also pins both halves of the `unit` gate.

## `order-api` is a two-slice modulith

`order-api` is the one deployment whose surface is big enough to split, so it
is: `src/slices/orders/` and `src/slices/customers/`, each owning a fragment
of the contract and a controller over that fragment, and each backed by the
same three-package vertical below it.

```
order-api-contract     contract.orders         contract.customers    ← private fragments; the root contract is { orders, customers }
                            │                        │
order-api              slices/orders/           slices/customers/
                         controller.ts            controller.ts     ← HttpController(name, fragment)([deps], { sync })
                         module.ts                module.ts         ← the slice's own di module
                            └───────────┬────────────┘
                                   module.ts                        ← HttpRouter(contract)({ orders, customers })
                            ┌───────────┴────────────┐
                       PlaceOrder / FindOrder    FindCustomer       ← use cases, entities, Prisma adapters — the same three packages
```

A **controller** is `HttpController("OrdersController", contract.orders)([PlaceOrder,
FindOrder], { sync })` — an ordinary di provider on a port `HttpController`
mints and hands back on `.port`. A **slice** is an ordinary di `Module` that
**imports the vertical it needs**, provides its controller and exports
**only** that controller, so nothing outside the slice can reach anything else
it holds. Neither slice owns a private adapter: both go through the use cases,
the entities and the Prisma repositories, and each controller converts its own
entity to its own wire shape. Each imports its **own** vertical —
`OrderApplicationModule` + `OrderPersistenceModule`, `CustomerApplicationModule`

- `CustomerPersistenceModule` — so neither slice carries the other's use case or
  adapter. They converge only on the internal database module both persistence
  halves import: a diamond, not duplication, since di flattens the tree into a
  `Set` keyed by provider reference and builds one database. The **root** is then a list of
  slices plus what no slice owns (`observability()`), composed with the
  keyed `HttpRouter(contract)({ orders: ordersController, customers:
customersController })` form, which is exact against the contract — a missing
  key, an undeclared key and a controller under the wrong key are all compile
  errors at that call.

Nothing here is a new concept: a controller is a provider, a slice is a
module, a modulith is several slice modules in one root — and `exports:
[ordersController]` is di's provider form, since `HttpController` mints the
port and there is no class to name. And because a
fragment is itself a valid contract, lifting `orders` into a process of its
own leaves the slice untouched —
`HttpRouter(contract.orders)([ordersController.port], { sync: (implementation) => implementation })`
is the whole of the lifted root's router. `packages/http/src/controller.test-d.ts`
pins that, and the four other gates, at compile time.

## Why these are tests, not just illustrations

Each package reads as application code, and each is covered by real specs — 86
of them, run by the repository's own `pnpm test`:

```sh
pnpm install
pnpm test        # every example's specs, alongside the kernel's own
pnpm typecheck   # includes the compile-time-only guarantees pinned with @ts-expect-error
```

Nothing is faked at the boundaries that matter. `order-infrastructure` runs
against a real Prisma client over a real PostgreSQL, so a `DuplicateOrder`
comes from an actual `UNIQUE` index raising an actual P2002. `order-api` runs a real
`node:http` server and a real oRPC client over it, so the collapse of a `Defect`
to `INTERNAL_SERVER_ERROR` happens where it really happens. `order-temporal-worker`
runs a real `TypedWorker` polling a real task queue, so a drain that lets an
in-flight activity finish is the SDK's own `DRAINING` state and not a mock of
it. The fixtures reach for the cheapest thing that tests the real behaviour,
and then **share** it: the Prisma client is generated by turbo's own task, and
the three servers these examples need — PostgreSQL, RabbitMQ, Temporal — are
one container each for the whole repository, owned by
[`internal/test-infra`](../internal/test-infra/README.md).

**Four of these workspaces need a Docker daemon**: `order-infrastructure`,
`order-api`, `order-amqp-worker` and `order-temporal-worker`. None of them
starts a server of its own, and none cleans up after a test — isolation is the
boundary each system already has, minted in setup: a **vhost** per test, a
**namespace** per spec file, a **tenant** per test. One `prisma migrate deploy`
runs for the whole gate.

A real broker in particular is the only
honest way to test a drain against a live broker connection and real
acknowledgement — what an abandoned delivery costs once the kernel's own
deadline passes is _not_ redelivery, only the release of a report; the broker
only redelivers once the connection itself drops, which happens when the
process actually dies, and that is not something a same-process suite can
observe. See
[`@btravstack/amqp`'s README](../packages/amqp/README.md#what-abandonment-costs).

The three deployment suites test through
[`@btravstack/testing`](../packages/testing), the way an application would:
each `src/test-fixtures.ts` has a `boot` fixture — `bootFixture(...)`, which
its `serve` builds on — so every app a test starts is stopped when the test
ends, on every exit path, and `tapped(module, [OrderRepository, …])` hands back
the very services the running app was built with (the repository the
compensation assertions read through, the writer the relay sweeps) instead of a
provider written into each suite to reach them. Log lines need no tap at all:
every deployment composes `@btravstack/observability`'s `observability()`, and
a spec swaps the default stdout sink for a recorder — so what a handler said
comes back as a `Line`, and the assertions read `attributes.orderId` and
`unit.traceId` as fields.

Where a guarantee is compile-time only — an unmet port, a runtime's `needs` —
the assertion is a `@ts-expect-error` in a `*.test-d.ts` file, checked by `tsc`
rather than executed.

Nothing here is published: every package is `"private": true` and depends on the
kernel via `workspace:*`.

## The container's one

[`hexagonal-order-api`](./hexagonal-order-api) came in with `@btravstack/di` when
it was merged into this repository, and it is about wiring rather than lifecycle:
it composes a `Module` and asserts what the container did, without booting a
process — ports named by the application, a private internal beside a public
surface, and one application module composed against a production adapter and an
in-memory one.

It is here for a second reason, and that one is load-bearing: it is the only
workspace in the repository that compiles **twice**. Its `typecheck` emits
declarations under the catalog's `typescript` and re-checks them under
`typescript-consumer` (5.9.3), because a published package has to be readable by
the stable line and the two emitters do not agree on everything.
`src/emit-guards.ts` is the fixture that keeps TS4020 — an unnameable private
type leaking into an emitted `.d.ts` — from coming back, and it is imported by
nothing on purpose: it exists to be compiled.

Two siblings came with it and were dropped in the same merge. `request-scope`
(a pool under `Module.scoped`, a transaction forked per request) is covered by
`packages/di/src/fork.spec.ts` and, in a real application, by
[`order-api`](./order-api)'s own per-request scope; `plugin-registry` (a
a plugin registry) was covered by
`packages/di/src/many.spec.ts`. Neither asserted anything the container's own
suite did not already pin, and an example that proves nothing new is an
illustration — which is what this directory is not.
