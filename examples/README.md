# Examples

Two example families share this directory. Eleven packages are **one
application booted four ways**: a clean architecture split across four layers,
deployed once as an oRPC API, once as a queue worker, once as a Temporal
worker and once as an AMQP consumer, with each transport's contract in a
package of its own — and, at the same time, exercising `@btravstack/start` end
to end from a consumer's own workspace, `workspace:*` and all. Three more —
[the di examples](#the-di-examples) below — exercise `@btravstack/di` on its
own, one job each.

| Package                                                | Layer     | Shows                                                                                                                                                            |
| ------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`order-domain`](./order-domain)                       | domain    | Entities and rules with no dependencies at all: branded fields, an `Entity.invariant` re-checked on every path, failures as values.                              |
| [`order-application`](./order-application)             | use cases | Ports declared by the caller, interactors, and an `ApplicationModule` whose `OrderRepository` is deliberately an **unmet need**.                                 |
| [`order-infrastructure`](./order-infrastructure)       | adapters  | A Prisma-backed repository over in-memory SQLite, translating P-codes into the domain's vocabulary and closing the application's one need.                       |
| [`order-config`](./order-config)                       | config    | The one environment-variable idiom the four deployments share: a non-empty string piped into a coercion, validated as a value, with the seven cases pinned once. |
| [`order-api-contract`](./order-api-contract)           | contract  | The oRPC contract on its own — wire shapes and declared error codes — taken by the server that implements it **and** by any client.                              |
| [`order-api`](./order-api)                             | runtime   | The first deployment: an oRPC router over `node:http`, a scope forked per request, and `Result` → `ORPCError`.                                                   |
| [`order-worker`](./order-worker)                       | runtime   | The second deployment: an in-memory queue worker over the **same** composition, and `Result` → ack / retry / dead-letter.                                        |
| [`order-temporal-contract`](./order-temporal-contract) | contract  | The Temporal contract on its own — one workflow, one activity, two declared `nonRetryable` errors — read by the worker, the sandbox and the client.              |
| [`order-temporal`](./order-temporal)                   | runtime   | The third deployment: `@btravstack/start-temporal` driving a Temporal worker, one unit per **activity attempt**, `Result` → typed contract error.                |
| [`order-amqp-contract`](./order-amqp-contract)         | contract  | The AMQP contract on its own — one exchange, one queue with a retry/dead-letter policy, one message — read by the worker and by any publisher.                   |
| [`order-amqp`](./order-amqp)                           | runtime   | The fourth deployment: `@btravstack/start-amqp` driving a real RabbitMQ worker, one unit per **delivery**, `Result` → `RetryableError` / `NonRetryableError`.    |

## The layering, and which way the arrows point

```
  order-api        order-worker      order-temporal      order-amqp   ← one runtime each; one process each
       └────────────────┼─────────────────┼──────────────────┘  ─────▶ order-config  ← how all four read the environment
                        ▼
             order-infrastructure                    ← Prisma, SQLite, P-codes
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
happens to satisfy it. `ApplicationModule` therefore leaves that need **unmet**,
which is not documentation but a type: `Module.scoped(ApplicationModule, …)`
does not compile until an outer module provides one.

## The contract tier, which depends on nothing and is depended upon

A transport's contract is a **shared artifact**, so each one is a package of its
own:

```
   order-api      any API client        order-temporal   any workflow client        order-amqp     any publisher
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
`order-api/src/contract.ts` and `order-temporal/src/contract.ts` before being
extracted, so no client could take one without the others until then;
`order-amqp-contract` started as its own package from the outset, the same
shape without the detour. None of the three depends on `@btravstack/start`, on
`@btravstack/di`, or on any other example — the transports depend on **them**.

The rule is enforced by the compiler rather than by review: each contract
package's `src/layering.test-d.ts` imports its transport package under a
`@ts-expect-error`, so adding the implementation to the contract's dependencies
makes the directive unused and fails `test:types` — the same shape
`order-domain` uses to keep the application layer out of the domain.

And the payoff is demonstrated rather than asserted. `order-api-contract`'s own
spec builds a real oRPC client from `RouterContractClient<typeof orderContract>`
and drives it over a stub `fetch`, with nothing from `order-api` in scope;
`order-temporal-contract`'s runs the workflow's input schema as a validator
returning a `Result`, which is the check a caller makes before starting an
execution — all a Temporal client can do without a running service.
`order-amqp-contract`'s runs the placement message's own payload schema the
same way, with no worker, no connection and no broker in scope — the check a
publisher makes before sending a message.

## One application, four deployments

`OrderApiModule`, `OrderWorkerModule`, `OrderTemporalModule` and
`OrderAmqpModule` are the same three lines:

```ts
imports: [ApplicationModule, PersistenceModule],
provides: [],
exports: [PlaceOrder, FindOrder, Logger],
```

Nothing in `order-application` or `order-infrastructure` differs between them,
and nothing could: the use cases return a `Result`, and what a `Result` means to
a transport is the transport's business. The kernel's headline claim — several
runtime _kinds_, one per process, over the same module — is proved here rather
than asserted, and the sharpest form of the proof is that **the same `Err`
becomes four different outcomes**:

| unthrown               | `order-api`             | `order-worker`              | `order-temporal`                        | `order-amqp`                                             |
| ---------------------- | ----------------------- | --------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `Ok(order)`            | the procedure's output  | **ack**                     | the workflow's output                   | **ack**                                                  |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | **dead-letter**             | `InvalidQuantity`, **non-retryable**    | `NonRetryableError`, **parked**                          |
| `Err(DuplicateOrder)`  | `CONFLICT`              | **dead-letter**             | `OrderAlreadyPlaced`, **non-retryable** | `NonRetryableError`, **parked**                          |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retry**, then dead-letter | **retried by the platform**, then fails | `RetryableError`, **retried by the broker**, then parked |

The kernel appears in none of the four columns. `RunUnit` hands a runtime the
work's own `Result` and stays out of what it means.

The fourth and fifth columns carry something the second and third do not.
Naming a failure on a Temporal contract decides not only what the caller sees
but **whether the platform retries it** — both domain errors are declared
`nonRetryable`, so Temporal asks exactly once, while an unmodelled failure
stays unnamed and the retry policy takes over. `order-worker` hand-rolls that
distinction with an attempt budget; on Temporal it is a line of contract, and
on AMQP it is too, in the broker's own vocabulary: `order-placements`'s
`retry: { mode: "ttl-backoff", maxRetries: 3 }` is contract configuration the
broker itself enforces, not a runtime constant. The count means something
different, though — `maxRetries: 3` is retries **on top of** the first
attempt, so an unmodelled failure is attempted **four** times in total before
it is parked, not the three `maximumAttempts: 3` names on Temporal.

## What each runtime calls a "unit"

The four deployments disagree about what one piece of work is, and the kernel
does not care — which is the point of `RunUnit` being parameterised by nothing
but `UnitMeta`:

|                  | one unit is              | `id`                    | `traceId`                         |
| ---------------- | ------------------------ | ----------------------- | --------------------------------- |
| `order-api`      | one HTTP request         | a fresh `randomUUID()`  | an inbound `x-request-id`, if any |
| `order-worker`   | one **delivery**         | `job#attempt`           | the message id                    |
| `order-temporal` | one **activity attempt** | Temporal's task token   | the workflow id                   |
| `order-amqp`     | one **delivery**         | a minted `randomUUID()` | the publisher's `messageId`       |

All four are answering the same obligation — `UnitMeta.id` must be unique per
unit, because `traceId` defaults to it — and all four land on "the attempt, not
the logical thing", because a retry is a second unit and the same trace.
`order-worker` and `order-amqp` agree on what a unit _is_ — one delivery — and
disagree on how to name it: a queue job id is already unique per attempt, a
delivery tag is not (see `order-amqp`'s own README for why), so one mints and
the other does not.

## The runtimes with a non-empty `needs`

`order-api`'s `httpRuntime` call declares `[PlaceOrder, FindOrder, Logger]`,
while `queueWorkerRuntime`, `temporalWorkerRuntime` and `orderAmqpRuntime` each
declare `[PlaceOrder, Logger]` — two of the three the module exports, because a
runtime declares what _it_ needs. The kernel's own `testRuntime` needs nothing,
so these four are what exercise `start`'s phantom rest-tuple gate and
`RuntimeHost`'s `Context<InstanceType<Needs>>` — where a runtime names port
_classes_ while di parameterises contexts by port _instances_ — against a real
module here. `@btravstack/start-http`'s own `AppModule`/`Greeting` fixture
(`packages/start-http/src/test-fixtures.ts`, driving its 12
`http-runtime.spec.ts` specs) exercises the same runtime-side path a second
way now. `examples/` stays the only place the gate is pinned by a **type
test**: `start-http` ships no `*.test-d.ts`.

All four directions are pinned, in `order-api/src/needs-gate.test-d.ts`,
`order-worker/src/needs-gate.test-d.ts`, `order-temporal/src/needs-gate.test-d.ts`
and `order-amqp/src/needs-gate.test-d.ts`: the wired call is an ordinary
two-argument one, and a module one port short fails on **arity**, naming the
missing need.

## Why these are tests, not just illustrations

Each package reads as application code, and each is covered by real specs — 93
of them, run by the repository's own `pnpm test`:

```sh
pnpm install
pnpm test        # every example's specs, alongside the kernel's own
pnpm typecheck   # includes the compile-time-only guarantees pinned with @ts-expect-error
```

Nothing is faked at the boundaries that matter. `order-infrastructure` runs
against a real Prisma client over in-memory SQLite, so a `DuplicateOrder` comes
from an actual `UNIQUE` index raising an actual P2002. `order-api` runs a real
`node:http` server and a real oRPC client over it, so the collapse of a `Defect`
to `INTERNAL_SERVER_ERROR` happens where it really happens. `order-temporal`
runs a real `TypedWorker` polling a real task queue, so a drain that lets an
in-flight activity finish is the SDK's own `DRAINING` state and not a mock of
it. The fixtures reach for the cheapest thing that tests the real behaviour: the
Prisma client is generated by the `test` script itself, Temporal's time-skipping
test server is a local binary rather than a container, and where neither exists —
`order-amqp` needs a real broker — the suite starts one with `testcontainers`.

Two suites need more than a checkout. `order-temporal` needs **network access on
a cold cache** to fetch that 64 MB binary once (cached at
`<repo>/.cache/temporal-test-server`, gitignored, with a year-long ttl), which
costs about 3.5 s, once — see
[`order-temporal`'s README](./order-temporal#running-it--and-the-one-thing-this-example-needs-that-the-others-do-not).
`order-amqp` needs a **Docker daemon**, because a real RabbitMQ is the only
honest way to test a drain against a live broker connection and real
acknowledgement — what an abandoned delivery costs once the kernel's own
deadline passes is _not_ redelivery, only the release of a report; the broker
only redelivers once the connection itself drops, which happens when the
process actually dies, and that is not something a same-process suite can
observe. See
[`@btravstack/start-amqp`'s README](../packages/start-amqp/README.md#what-abandonment-costs).

Where a guarantee is compile-time only — an unmet port, a runtime's `needs` —
the assertion is a `@ts-expect-error` in a `*.test-d.ts` file, checked by `tsc`
rather than executed.

Nothing here is published: every package is `"private": true` and depends on the
kernel via `workspace:*`.

## The di examples

Three packages, each showing a different job `@btravstack/di` does on its
own — no kernel, no runtime — and, at the same time, exercising the library
end to end from a consumer's own workspace.

| Package                                        | Shows                                                                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hexagonal-order-api`](./hexagonal-order-api) | The core story: ports named by the application, a private internal beside a public surface, and one application module composed against a production adapter and an in-memory one. |
| [`request-scope`](./request-scope)             | Lifetime management: a pool acquired once under `Module.scoped`, and a `Module.forkScope`'d transaction per request over the built parent.                                         |
| [`plugin-registry`](./plugin-registry)         | Multi-binding: a `Port.many` set port fed by contributions from two independent modules, collected and run together.                                                               |

The same rules as the order family: each `src/index.ts` reads as application
code, each spec asserts real behaviour (release order, set-port accumulation),
and compile-time-only guarantees live in `*.test-d.ts` — see
`hexagonal-order-api/src/index.test-d.ts`, which also runs declaration emit
under both the repo's TypeScript and a consumer's stable one. Every package
declares `unthrown` itself, because it is a peer of the library, not a
transitive.
