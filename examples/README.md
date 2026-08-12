# Examples

Six small packages that are **one application booted three ways**: a clean
architecture split across four layers, deployed once as an oRPC API, once as a
queue worker and once as a Temporal worker — and, at the same time, exercising
`@btravstack/start` end to end from a consumer's own workspace, `workspace:*`
and all.

| Package                                          | Layer     | Shows                                                                                                                                      |
| ------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`order-domain`](./order-domain)                 | domain    | Entities and rules with no dependencies at all: branded fields, an `Entity.invariant` re-checked on every path, failures as values.        |
| [`order-application`](./order-application)       | use cases | Ports declared by the caller, interactors, and an `ApplicationModule` whose `OrderRepository` is deliberately an **unmet need**.           |
| [`order-infrastructure`](./order-infrastructure) | adapters  | A Prisma-backed repository over in-memory SQLite, translating P-codes into the domain's vocabulary and closing the application's one need. |
| [`order-api`](./order-api)                       | runtime   | The first deployment: an oRPC router over `node:http`, a scope forked per request, and `Result` → `ORPCError`.                             |
| [`order-worker`](./order-worker)                 | runtime   | The second deployment: an in-memory queue worker over the **same** composition, and `Result` → ack / retry / dead-letter.                  |
| [`order-temporal`](./order-temporal)             | runtime   | The third deployment: a Temporal worker whose **activity is the kernel unit**, `Result` → typed contract error, and a drain that waits.    |

## The layering, and which way the arrows point

```
  order-api        order-worker      order-temporal   ← one runtime each; one process each
       └────────────────┬─────────────────┘
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

## One application, three deployments

`OrderApiModule`, `OrderWorkerModule` and `OrderTemporalModule` are the same
three lines:

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
becomes three different outcomes**:

| unthrown               | `order-api`             | `order-worker`              | `order-temporal`                        |
| ---------------------- | ----------------------- | --------------------------- | --------------------------------------- |
| `Ok(order)`            | the procedure's output  | **ack**                     | the workflow's output                   |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | **dead-letter**             | `InvalidQuantity`, **non-retryable**    |
| `Err(DuplicateOrder)`  | `CONFLICT`              | **dead-letter**             | `OrderAlreadyPlaced`, **non-retryable** |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retry**, then dead-letter | **retried by the platform**, then fails |

The kernel appears in none of the three columns. `RunUnit` hands a runtime the
work's own `Result` and stays out of what it means.

The fourth column carries something the other two do not. Naming a failure on a
Temporal contract decides not only what the caller sees but **whether the
platform retries it** — both domain errors are declared `nonRetryable`, so
Temporal asks exactly once, while an unmodelled failure stays unnamed and the
retry policy takes over. `order-worker` hand-rolls that distinction with an
attempt budget; on Temporal it is a line of contract.

## What each runtime calls a "unit"

The three deployments disagree about what one piece of work is, and the kernel
does not care — which is the point of `RunUnit` being parameterised by nothing
but `UnitMeta`:

|                  | one unit is              | `id`                   | `traceId`                         |
| ---------------- | ------------------------ | ---------------------- | --------------------------------- |
| `order-api`      | one HTTP request         | a fresh `randomUUID()` | an inbound `x-request-id`, if any |
| `order-worker`   | one **delivery**         | `job#attempt`          | the message id                    |
| `order-temporal` | one **activity attempt** | Temporal's task token  | the workflow id                   |

All three are answering the same obligation — `UnitMeta.id` must be unique per
unit, because `traceId` defaults to it — and all three land on "the attempt, not
the logical thing", because a retry is a second unit and the same trace.

## The only non-empty `needs` in the repo

`orpcRuntime` declares `[PlaceOrder, FindOrder, Logger]`, while
`queueWorkerRuntime` and `temporalWorkerRuntime` each declare
`[PlaceOrder, Logger]` — two of the three the module exports, because a runtime
declares what _it_ needs. They are the **only runtimes in this repository with a
non-empty `needs`**: the kernel's own `testRuntime` needs nothing, so `start`'s
phantom rest-tuple gate — and `RuntimeHost`'s `Context<InstanceType<Needs>>`,
where a runtime names port _classes_ while di parameterises contexts by port
_instances_ — are exercised against a real module here and nowhere else.

All three directions are pinned, in `order-api/src/needs-gate.test-d.ts`,
`order-worker/src/needs-gate.test-d.ts` and
`order-temporal/src/needs-gate.test-d.ts`: the wired call is an ordinary
two-argument one, and a module one port short fails on **arity**, naming the
missing need.

## Why these are tests, not just illustrations

Each package reads as application code, and each is covered by real specs — 70
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
it. **No Docker**: the Prisma client is generated by the `test` script itself,
and Temporal's time-skipping test server is a local binary rather than a
container.

One caveat, and it is the only one in this directory: `order-temporal` needs
**network access on a cold cache** to fetch that 64 MB binary once (cached at
`<repo>/.cache/temporal-test-server`, gitignored, with a year-long ttl). Every
other example is entirely self-contained. The trade was taken deliberately —
the alternative, a real Temporal cluster under `testcontainers`, needs a network
pull _and_ a daemon — and it costs about 3.5 s, once. See
[`order-temporal`'s README](./order-temporal#running-it--and-the-one-thing-this-example-needs-that-the-others-do-not).

Where a guarantee is compile-time only — an unmet port, a runtime's `needs` —
the assertion is a `@ts-expect-error` in a `*.test-d.ts` file, checked by `tsc`
rather than executed.

Nothing here is published: every package is `"private": true` and depends on the
kernel via `workspace:*`.
