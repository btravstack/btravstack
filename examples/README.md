# Examples

Ten small packages, none of them published, all of them in the gate.

The **`order-*` nine** are one application booted three ways: a clean
architecture split across four layers, deployed once as an oRPC API, once as a
Temporal worker and once as an AMQP consumer, with each transport's contract in a
package of its own — and, at the same time, exercising `@btravstack/core` end to
end from a consumer's own workspace, `workspace:*` and all.

The **tenth**, [`di-hexagonal`](#the-containers-one), came with
`@btravstack/di` and is the container's own: it composes a `Module` and never
calls `start`.

| Package                                                | Layer     | Shows                                                                                                                                                                                                        |
| ------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`order-domain`](./order-domain)                       | domain    | Entities and rules with no dependencies at all: branded fields, an `Entity.invariant` re-checked on every path, failures as values.                                                                          |
| [`order-application`](./order-application)             | use cases | Ports declared by the caller, interactors, and one module per vertical whose repository — and, for orders, `Logger` — is deliberately an **unmet need**.                                                     |
| [`order-infrastructure`](./order-infrastructure)       | adapters  | Prisma-backed repositories over a multi-tenant PostgreSQL schema, translating P-codes into the domain's vocabulary and closing the application's repository needs.                                           |
| [`order-api-contract`](./order-api-contract)           | contract  | The oRPC contract on its own — wire shapes and declared error codes — taken by the server that implements it **and** by any client.                                                                          |
| [`order-api`](./order-api)                             | runtime   | The first deployment: a two-slice modulith — a controller per contract fragment, composed into one oRPC router — served by `http()`, and `Result` → `ORPCError`.                                             |
| [`order-temporal-contract`](./order-temporal-contract) | contract  | The Temporal contract on its own — two workflows, eight activities, five declared `nonRetryable` errors — read by the worker, the sandbox and the client.                                                    |
| [`order-temporal-worker`](./order-temporal-worker)     | runtime   | The **orchestration** deployment: two saga slices on `@btravstack/temporal-worker` — `fulfillOrder` places, reserves and ships with compensation in reverse; `chargeOrder` authorizes and refunds a payment. |
| [`order-amqp-contract`](./order-amqp-contract)         | contract  | The AMQP contract on its own — one exchange, one event, two subscriber queues each with its own retry/dead-letter policy — read by the relay and by any subscriber.                                          |
| [`order-amqp-worker`](./order-amqp-worker)             | runtime   | The **broadcast** deployment: two subscriber slices over a transactional outbox relayed onto RabbitMQ by `@btravstack/amqp-worker`'s worker — every committed write becomes an event.                        |

## The layering, and which way the arrows point

```text
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
module provides one. There is one such module per vertical, so each gate
carries the repository that vertical actually uses — carries, not prints: di's
gate is an arity error, and the port is in the parameter's type.

## What each one shows, in full

The walkthroughs live on the documentation site, one page per example — the
contract tier, what each runtime calls a "unit", what it resolves and how the
gate sees it, and `order-api`'s two-slice modulith end to end:

- [Examples](https://btravstack.github.io/btravstack/examples/) — the index, and the layering again with links.
- [The order application](https://btravstack.github.io/btravstack/examples/order-application) — domain, use cases, ports, adapters.
- [Order API (HTTP)](https://btravstack.github.io/btravstack/examples/order-api) — the modulith, the controllers, the triage.
- [Order Temporal worker](https://btravstack.github.io/btravstack/examples/order-temporal-worker) — the sagas and their compensation.
- [Order AMQP worker](https://btravstack.github.io/btravstack/examples/order-amqp-worker) — the outbox, the relay, the two subscribers.
- [Hexagonal (di alone)](https://btravstack.github.io/btravstack/examples/di-hexagonal) — wiring without a lifecycle.

This file is the **index a contributor reads in the repository**: the table
above, the layering, and the two facts below that are about this checkout
rather than about the application. Everything else is one page away, written
once.

## Why these are tests, not just illustrations

Each package reads as application code, and each is covered by real specs the
repository's own `pnpm test` runs:

```sh
pnpm install
pnpm test        # every example's specs, alongside the kernel's own
pnpm typecheck   # includes the compile-time-only guarantees pinned with @ts-expect-error
pnpm dev         # the three deployments, side by side, watching
```

`pnpm dev` is the local loop: it brings up the same three shared containers
the specs use, applies the migrations, and runs all three entry points at once
with their output prefixed by workspace — one process per deployment, exactly
as in production, because that is the only way the drain and the failure
isolation mean anything. See
[Run several deployments locally](../docs/how-to/run-several-deployments-locally.md).

Nothing is faked at the boundaries that matter. `order-infrastructure` runs
against a real Prisma client over a real PostgreSQL, so a `DuplicateOrder`
comes from an actual `UNIQUE` index raising an actual P2002. `order-api` runs a real
`node:http` server and a real oRPC client over it, so the collapse of a `Defect`
to `INTERNAL_SERVER_ERROR` happens where it really happens. `order-temporal-worker`
runs a real `TypedWorker` polling a real task queue, so a drain that lets an
in-flight activity finish is the SDK's own `DRAINING` state and not a mock of
it. The fixtures reach for the cheapest thing that tests the real behaviour,
and then **share** it: the Prisma client is generated by turbo's own task, and
every backing service these examples need — PostgreSQL, RabbitMQ, Temporal,
Redis, Mailpit and an S3-compatible store — is one shared container for the
whole repository, owned by
[`internal/test-infra`](../internal/test-infra/README.md), which is where the
list lives.

**Four of these workspaces need a Docker daemon** — `order-infrastructure`,
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
[`@btravstack/amqp-worker`'s README](../packages/amqp-worker/README.md#what-abandonment-costs).

The three deployment suites test through
[`@btravstack/testing`](../packages/testing), the way an application would:
each `src/__tests__/test-fixtures.ts` has a `boot` fixture — `bootFixture(...)`, which
its `serve` builds on — so every app a test starts is stopped when the test
ends, on every exit path, and `tapped(module, [OrderRepository, …])` hands back
the very services the running app was built with (the repository the
compensation assertions read through, the writer the relay sweeps) instead of a
provider written into each suite to reach them. Log lines need no tap at all:
every deployment composes `@btravstack/observability`'s `observability()`, and
a spec swaps the default stdout sink for a recorder — so what a handler said
comes back as a `Line`, and the assertions read `attributes.orderId` and
`unit.traceId` as fields.

Where a guarantee is compile-time only — an unmet port, a runtime's `resolves` —
the assertion is a `@ts-expect-error` in a `*.test-d.ts` file, checked by `tsc`
rather than executed.

Nothing here is published: every package is `"private": true` and depends on the
kernel via `workspace:*`.

## The container's one

[`di-hexagonal`](./di-hexagonal) came in with `@btravstack/di` when
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
`Port.many` set port fed by two modules) is covered by
`packages/di/src/many.spec.ts`. Neither asserted anything the container's own
suite did not already pin, and an example that proves nothing new is an
illustration — which is what this directory is not.
