# Examples

Nine small packages that are **one application booted four ways**: a clean
architecture split across four layers, deployed once as an oRPC API, once as a
queue worker, once as a Temporal worker and once as an AMQP consumer, with each
transport's contract in a package of its own — and, at the same time,
exercising `@btravstack/start-core` end to end from a consumer's own workspace,
`workspace:*` and all.

| Package                                                | Layer     | Shows                                                                                                                                                       |
| ------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`order-domain`](./order-domain)                       | domain    | Entities and rules with no dependencies at all: branded fields, an `Entity.invariant` re-checked on every path, failures as values.                         |
| [`order-application`](./order-application)             | use cases | Ports declared by the caller, interactors, and an `ApplicationModule` whose `OrderRepository` is deliberately an **unmet need**.                            |
| [`order-infrastructure`](./order-infrastructure)       | adapters  | A Prisma-backed repository over in-memory SQLite, translating P-codes into the domain's vocabulary and closing the application's one need.                  |
| [`order-api-contract`](./order-api-contract)           | contract  | The oRPC contract on its own — wire shapes and declared error codes — taken by the server that implements it **and** by any client.                         |
| [`order-api`](./order-api)                             | runtime   | The first deployment: an oRPC router over `node:http`, a scope forked per request, and `Result` → `ORPCError`.                                              |
| [`order-temporal-contract`](./order-temporal-contract) | contract  | The Temporal contract on its own — one workflow, five activities, four declared `nonRetryable` errors — read by the worker, the sandbox and the client.     |
| [`order-temporal-worker`](./order-temporal-worker)     | runtime   | The **orchestration** deployment: a fulfillment saga on `@btravstack/start-temporal` — place, reserve, ship, and compensation in reverse on a permanent no. |
| [`order-amqp-contract`](./order-amqp-contract)         | contract  | The AMQP contract on its own — one exchange, one event, one subscriber queue with a retry/dead-letter policy — read by the relay and by any subscriber.     |
| [`order-amqp-worker`](./order-amqp-worker)             | runtime   | The **broadcast** deployment: a transactional outbox relayed onto RabbitMQ by `@btravstack/start-amqp`'s worker — every committed write becomes an event.   |

## The layering, and which way the arrows point

```
  order-api      order-temporal-worker      order-amqp-worker   ← one runtime each; one process each
       └────────────────┼──────────────────┘  ─────▶ @btravstack/config  ← how all three read the environment
                        ▼
             order-infrastructure                    ← Prisma, SQLite, P-codes
                        │  provides OrderRepository
                        ▼
              order-application                     ← use cases, and the ports they declare
                        │
                        ▼
                 order-domain                       ← entities and rules; depends on nothing
```

There used to be an `order-config` package on the right-hand arrow, holding the
one environment-variable idiom the three deployments shared. It is gone:
[`@btravstack/config`](../packages/config) owns that idiom now — `wholeNumber`
and `port` are its `@btravstack/config/zod` builders, `describeEnvIssues` is
its `describeIssues` — and each deployment declares its own configs with
`Config(id)(shape, options?)` instead of hand-rolling a schema over
`process.env`. See [Configuration](#configuration) below.

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
shape without the detour. None of the three depends on `@btravstack/start-core`, on
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

## One application, three deployments — each doing what its transport is for

Every composition root imports the same pair — `ApplicationModule`,
`PersistenceModule` — and exports its own selection of ports: nothing in
`order-application` or `order-infrastructure` differs between deployments, and
nothing could. What differs is what each transport is **for**:

- **`order-api`** answers a caller: a request arrives, a typed answer leaves.
- **`order-temporal-worker`** owns a journey: the fulfillment saga runs steps
  in order and compensates in reverse when one answers a permanent no —
  orchestration, which needs a durable owner.
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
`order-worker` and `order-amqp-worker` agree on what a unit _is_ — one delivery — and
disagree on how to name it: a queue job id is already unique per attempt, a
delivery tag is not (see `order-amqp-worker`'s own README for why), so one mints and
the other does not.

## The runtimes with a non-empty `needs`

`orderApiRuntime` declares `[PlaceOrder, FindOrder, Logger, httpConfig]`,
`temporalWorkerRuntime` its five application ports plus `temporalConfig`, and
`orderAmqpRuntime` `[Outbox, Logger, amqpConfig, outboxRelayConfig]` — a
selection of what the module exports, because a runtime declares what _it_
needs. **Configuration is inside that selection**, which is the point: a config
is a port like any other, so a deployment that forgot to import one fails to
compile rather than to boot. The kernel's own `testRuntime` needs nothing, so
these are what exercise `start`'s phantom rest-tuple gate and
`RuntimeHost`'s `Context<InstanceType<Needs>>` — where a runtime names port
_classes_ while di parameterises contexts by port _instances_ — against a real
module here. `@btravstack/start-http`'s own `AppModule`/`Greeting` fixture
(`packages/start-http/src/test-fixtures.ts`, driving its 12
`http-runtime.spec.ts` specs) exercises the same runtime-side path a second
way now. `examples/` stays the only place the gate is pinned by a **type
test**: `start-http` ships no `*.test-d.ts`.

All three directions are pinned, in `order-api/src/needs-gate.test-d.ts`,
`order-temporal-worker/src/needs-gate.test-d.ts`
and `order-amqp-worker/src/needs-gate.test-d.ts`: the wired call is an ordinary
two-argument one, and a module one port short fails on **arity**, naming the
missing need.

## Configuration

Every deployment declares its configuration with
[`@btravstack/config`](../packages/config), and none of them has an `env.ts`.

| Variable             | Deployment              | Declared by         | Default                 |
| -------------------- | ----------------------- | ------------------- | ----------------------- |
| `HTTP_PORT`          | `order-api`             | `httpConfig`        | `3000`                  |
| `TEMPORAL_ADDRESS`   | `order-temporal-worker` | `temporalConfig`    | `127.0.0.1:7233`        |
| `TEMPORAL_NAMESPACE` | `order-temporal-worker` | `temporalConfig`    | `default`               |
| `AMQP_URL`           | `order-amqp-worker`     | `amqpConfig`        | `amqp://127.0.0.1:5672` |
| `OUTBOX_POLL_MS`     | `order-amqp-worker`     | `outboxRelayConfig` | `200`                   |
| `PROBE_PORT`         | all three               | `probeConfig`       | `9000`                  |

Every name is what it was before the package existed, bar one: `order-api`'s
`HTTP_PORT` was `PORT`, and a bare `PORT` is not expressible — a config's
variables are `PREFIX_KEY`, and no prefix and key join to it.

Three things changed, and all three are worth copying:

**A config is one value, and it is a di port.**
`Config("Amqp")({ url: … })` is at once the token `ctx.get(amqpConfig)` reads
and the module `imports: [amqpConfig]` provides — no port declared here and an
adapter written for it there. `Config.source(process.env)` is the single place
the environment enters a graph, so a spec swaps the whole environment by
importing a different one (`order-amqp-worker`'s fixtures give each test its
own vhost that way).

**It travels through the graph, not through `main`.** A runtime is handed a
`Context` at `start`, so it names its configs in `needs` and reads them itself.
`main.ts` no longer knows what a broker URL, a namespace or a listening port
is, and the needs gate proves the graph carries them before anything runs.

**One report, not one deploy per typo.**
`Config.parse(Config.collect(Root), process.env)` validates every config
reachable from the composition root against one source and aggregates the lot
into a single `ConfigInvalid`; `describeIssues` prints one line per wrong
variable. Because `ConfigInvalid` is a `TaggedError`, the fold that reports it
enumerates it properly — the `P._` catch-all and its lint-disable, which the
old hand-rolled `SchemaIssues` fold needed, are gone from all three entry
points.

One thing is **not** clean yet, and each `main.ts` says so at the exact line:
`PROBE_PORT` (and `order-temporal-worker`'s `TEMPORAL_ADDRESS`) is still read
straight from `process.env`, because `start` binds the probe server — and the
Temporal connection is opened — before the graph exists, and phase 1 has no
way to read one config's value outside a graph. Both are still declared and
still validated in the report above. Kernel integration is phase 2's, in
`@btravstack/start-core`.

## Why these are tests, not just illustrations

Each package reads as application code, and each is covered by real specs — 68
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
to `INTERNAL_SERVER_ERROR` happens where it really happens. `order-temporal-worker`
runs a real `TypedWorker` polling a real task queue, so a drain that lets an
in-flight activity finish is the SDK's own `DRAINING` state and not a mock of
it. The fixtures reach for the cheapest thing that tests the real behaviour: the
Prisma client is generated by the `test` script itself, Temporal's time-skipping
test server is a local binary rather than a container, and where neither exists —
`order-amqp-worker` needs a real broker — the suite starts one with `testcontainers`.

Two suites need more than a checkout. `order-temporal-worker` needs **network access on
a cold cache** to fetch that 64 MB binary once (cached at
`<repo>/.cache/temporal-test-server`, gitignored, with a year-long ttl), which
costs about 3.5 s, once — see
[`order-temporal-worker`'s README](./order-temporal-worker#running-it--and-the-one-thing-this-example-needs-that-the-others-do-not).
`order-amqp-worker` needs a **Docker daemon**, because a real RabbitMQ is the only
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
