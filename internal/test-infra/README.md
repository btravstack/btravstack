# @btravstack/internal-test-infra

The repository's shared test infrastructure. Private, never published, and not
an example of anything — it exists so the gate needs **one** of each server
rather than one per workspace.

## What it starts

| Container                          | Who uses it                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `postgres:18.1`                    | Temporal's own persistence, and the example application's `orders` database |
| `rabbitmq:4.2.1-management-alpine` | `packages/amqp`, `examples/order-amqp-worker`                               |
| `temporalio/auto-setup:1.29.1`     | `packages/temporal`, `examples/order-temporal-worker`                       |

Three containers for six workspaces. Before this existed there were five
servers for those six — two RabbitMQ containers and up to three Temporal
time-skipping servers — and `pnpm test` was intermittently red at turbo's
default concurrency because the 60s testcontainers startup wait was what gave
out first ([#52](https://github.com/btravstack/start/issues/52)).

## Isolation is logical, not physical

Sharing a server costs nothing because each system already has a boundary
finer than "a server of my own":

- **A vhost per test.** `@amqp-contract/testing`'s `it` extension already
  minted one from the management API; only the container was ever duplicated.
- **A namespace per spec file.** `createNamespace` registers one and waits for
  every Temporal service's registry to catch up before returning it — a
  `startWorkflow` issued the instant `registerNamespace` resolves fails with
  `NamespaceNotFound` until they do. Per file rather than per test because
  registration costs that refresh, and a task queue per test (which both
  suites already mint) is what separates tests inside a file.
- **A tenant per test.** The example application is multi-tenant, so one
  migrated database serves the whole gate. See
  `examples/order-infrastructure/README.md`.

## Reuse, and what it costs

`withReuse()` is what makes the second, third and fourth workspace attach to a
container instead of starting one: testcontainers hashes the creation options
and fetches by that hash. Two consequences are deliberate.

**A reused container is not registered with Ryuk, so it outlives the run.**
That is the trade — a warm container costs nothing to attach to, and a cold one
costs the image pull the issue was about. To remove them:

```sh
docker rm -f $(docker ps -aq --filter label=com.btravstack.test-infra)
```

**testcontainers' own reuse lock is in-process**, which does nothing about the
case this repository actually has: turbo starting several workspaces' vitest
runs at the same instant, each missing the fetch-by-label and each starting a
container. `withLock` is a `mkdir`-based file lock under `<repo>/.cache/`
(gitignored) that closes it.

A file lock has one failure mode worth naming, because this repository hit it:
**a holder that is killed never releases.** Turbo cancels sibling tasks as soon
as one fails, so a waiter timing out takes down the very process holding the
lock, and the next run then queues behind a lock nobody owns. `withLock`
therefore writes its **pid** into the lock and treats a lock whose process is
gone as free immediately — `process.kill(pid, 0)`, which checks liveness
without delivering a signal. The time-based window is only the fallback for
what a pid cannot answer (another machine, a recycled number), and it is
deliberately **shorter** than the wait: a stale window longer than the wait can
never self-heal, because every waiter gives up before the lock is old enough to
break.

## Entry points

| Import                                       | What it is                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@btravstack/internal-test-infra/rabbitmq`   | a vitest `globalSetup` providing `@amqp-contract/testing`'s inject keys            |
| `@btravstack/internal-test-infra/temporal`   | a vitest `globalSetup` providing `@temporal-contract/testing`'s                    |
| `@btravstack/internal-test-infra/containers` | `sharedPostgres` / `sharedRabbitMq` / `sharedTemporal`, `postgresUrl`              |
| `@btravstack/internal-test-infra/namespace`  | `createNamespace(address, prefix)`                                                 |
| `@btravstack/internal-test-infra/lock`       | `withLock(name, run)`                                                              |
| `@btravstack/internal-test-infra/uuid`       | `uuidv7()`, a real UUIDv7 for the tenant fixtures — `crypto.randomUUID()` mints v4 |

The two setup modules are drop-in replacements for
`@amqp-contract/testing/global-setup` and
`@temporal-contract/testing/global-setup`: they provide the **same** inject
keys, so both upstream `it` extensions keep working unchanged.

**Each setup declares the keys it provides**, in its own module, and a
workspace pulls in the augmentation for exactly the setups it registers — so
the `import type` list in a `src/vitest.d.ts` mirrors the `globalSetup` list in
the `vitest.config.ts` beside it, and `inject` knows only what that run
actually started. `examples/order-infrastructure/src/global-setup.ts` follows
the same rule for its own `__ORDERS_DATABASE_URL__`. One caveat, which costs an
afternoon if missed: an augmenting module needs `import type {} from "vitest"`
of its own, because TypeScript can only augment a module the program has
already loaded.

## Running the gate needs Docker

Every workspace that boots the example application or either broker-backed
runtime needs a daemon. Measured on this machine, `pnpm test` (27 tasks, default
concurrency): **32s warm**, and a cold first run pays the three image pulls
once ever rather than once per run.
