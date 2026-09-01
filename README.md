<!-- doctest: prelude
import { Port, type Module } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
import {
  DuplicateOrder,
  InvalidOrderId,
  InvalidQuantity,
  type Order,
} from "@btravstack/example-order-domain";
class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (
    id: string,
    quantity: number,
  ) => AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder>;
}> {}
declare const OrderApplicationModule: Module<PlaceOrder, never, never>;
declare const OrderPersistenceModule: Module<never, never, never>;
-->

<div align="center">

# btravstack

**A backend framework for [Node.js](https://nodejs.org/) and
[TypeScript](https://www.typescriptlang.org/) — dependency injection the
compiler proves, errors as values instead of exceptions, and a process that
shuts down the way Kubernetes expects.**

[![CI](https://github.com/btravstack/btravstack/actions/workflows/ci.yml/badge.svg)](https://github.com/btravstack/btravstack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40btravstack%2Fcore.svg?logo=npm)](https://www.npmjs.com/package/@btravstack/core)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**Documentation**](https://btravstack.github.io/btravstack/) · [**Get Started**](https://btravstack.github.io/btravstack/tutorial/getting-started) · [**Why btravstack?**](https://btravstack.github.io/btravstack/explanation/why-btravstack)

</div>

btravstack is the layer between your business logic and the process it runs in.
You build an application out of **ports and providers**, and the compiler checks
that everything one needs, another supplies. A **starter** then brings the
transport — an HTTP server, a Temporal worker, an AMQP consumer — and the
framework owns boot, readiness and shutdown.

It is **not** a full-stack framework: no ORM, no templating, no frontend. What
it replaces is the `main.ts` every backend writes by hand and gets subtly wrong.

## What you get

|                          |                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| **Dependency injection** | Plain values — no decorators, no `reflect-metadata`. An unmet dependency is a compile error.    |
| **Errors as values**     | Every fallible call returns a `Result`, so the compiler makes you handle failure.               |
| **Configuration**        | Environment variables validated once at boot into typed values; a bad one exits `78` naming it. |
| **Three transports**     | HTTP (contract-first, over oRPC), Temporal workers, AMQP consumers.                             |
| **Observability**        | Structured logs correlated per request, OpenTelemetry traces and metrics.                       |
| **Lifecycle**            | Health probes, graceful drain, resource cleanup on every exit path.                             |
| **Testing**              | A harness that boots the real graph and swaps one provider at a time.                           |

## Why btravstack?

Every backend process gets the same things wrong on its own: it stops
accepting the instant SIGTERM lands and rejects the traffic Kubernetes is
still routing to it; its readiness probe answers from a transport rather than
from its state; a failed finaliser is logged and forgotten; a crash exits `0`.
btravstack gets them right once, as defaults.

- 🧩 **Business code only.** A composition root is a
  `HttpModule("OrdersApi")({ router, imports, exports, needs })` and a `main.ts` is
  `await runMain(OrdersApi)`. Configuration is bound from the environment
  inside the graph; there is no `process.env`, no `app.listen`, no signal
  handler to write.
- 🛂 **Wiring proven at compile time.** A module missing a provider, a
  composition root exporting no runtime, a runtime naming a port the graph
  does not carry — each is a type error at the call site, not a crash at boot.
- 🚦 **A drain that survives Kubernetes.** Readiness flips first, the kernel
  waits out the eventually-consistent endpoint removal, then in-flight work
  gets its deadline; whatever is still open is aborted and reported
  `abandoned`.
- 🎯 **Nothing throws.** Every async surface is an
  [`unthrown`](https://github.com/btravstack/unthrown) `AsyncResult`; the
  kernel never calls `process.exit`, and `runMain` is the one place a
  process's fate becomes an exit code — `0`, `1`, `2`, `70` or `78`, each
  meaning one thing.

## How it compares

|                      | btravstack      | NestJS                | AdonisJS              | Hand-rolled       |
| -------------------- | --------------- | --------------------- | --------------------- | ----------------- |
| Wiring checked       | at compile time | at boot               | at boot               | never             |
| Dependency injection | plain values    | decorators + metadata | decorators + metadata | by hand           |
| Errors               | values, typed   | exceptions + filters  | exceptions + handlers | your choice       |
| Graceful shutdown    | default         | opt-in hooks          | opt-in hooks          | write it yourself |
| Ecosystem            | small, growing  | very large            | large                 | none              |
| Full-stack           | no              | no                    | yes                   | —                 |

**NestJS has far more packages, integrations and hiring pool**, and decorators
are more concise to write. If that trade matters more than compile-time
certainty, Nest is the better tool — the
[Coming from NestJS](https://btravstack.github.io/btravstack/explanation/coming-from-nestjs)
page says so in detail, including what Nest does better.

btravstack is for teams that already chose TypeScript for the type safety and
want the framework to honour that choice rather than opt out of it. See
[Why btravstack?](https://btravstack.github.io/btravstack/explanation/why-btravstack)
for the design argument and what it is not.

## Install

```sh
pnpm add @btravstack/core @btravstack/config @btravstack/di unthrown
```

For an HTTP API add the starter and its peers:

```sh
pnpm add @btravstack/http-server @orpc/server @orpc/contract @unthrown/orpc
```

Everything is a **peer dependency** — the application holds one copy of each,
which is what keeps port identity and `isResult` honest across packages. The
kernel and `@btravstack/config` depend on `node:` builtins only. Node `>=22`.

## Quick example

An HTTP API is a contract, a router that implements it from the use cases it
declares, and a composition root. This is
[`examples/order-api`](./examples/order-api)'s **orders slice**, served on its
own and condensed to one procedure — the example itself composes that slice
and a `customers` one into a single router through controllers:

**`contract.ts`** — declared before any implementation exists; a client needs only this file.

```ts
import { oc, type } from "@orpc/contract";

export const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<{ readonly id: string; readonly quantity: number }>())
    .errors({
      INVALID_QUANTITY: { data: type<{ readonly id: string }>() },
      BAD_REQUEST: { data: type<{ readonly id: string }>() },
      CONFLICT: { data: type<{ readonly id: string }>() },
    }),
};
```

**`router.ts`** — one `Result`-returning function per procedure, typed by the contract.

```ts
import { defineHttp } from "@btravstack/http-server";
import { P } from "unthrown";

// One call mints every marker-typed HTTP entity; a public API declares no
// security scheme, so it takes no argument.
const api = defineHttp();

export const ordersRouter = api.OrpcRouter(ordersContract)({
  inject: { place: PlaceOrder },
  sync: ({ place }) => ({
    place: ({ errors }, input) =>
      place
        .execute(input.id, input.quantity)
        .map((order) => ({ id: order.id, quantity: order.quantity }))
        // The one place a domain error becomes a transport one — exhaustive,
        // so a new domain error is a compile error here.
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              errors.INVALID_QUANTITY({
                message: error.message,
                data: { id: error.id },
              }),
            )
            // A malformed id is the caller's mistake, so 400 — not the
            // 409 a duplicate gets.
            .with(P.tag("InvalidOrderId"), (error) =>
              errors.BAD_REQUEST({
                message: error.message,
                data: { id: error.id },
              }),
            )
            .with(P.tag("DuplicateOrder"), (error) =>
              errors.CONFLICT({
                message: error.message,
                data: { id: error.id },
              }),
            ),
        ),
  }),
});
```

**`main.ts`** — the composition root and the entry point; this is the whole process.

```ts
import { runMain } from "@btravstack/core";
import { HttpModule } from "@btravstack/http-server";

const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [OrderApplicationModule, OrderPersistenceModule],
});

await runMain(OrdersApi);
```

`HttpModule` is sugar over the same primitives: it imports the starter
(`PORT` and `HOST` bound from the environment, the router mounted under
`/rpc`), provides the router and exports the runtime port, and returns exactly
the di module a hand-written `Module("OrdersApi")({...})` would have. `runMain`
builds the graph, serves it, drains it on SIGTERM in three beats, and sets the
exit code. Boot the **same** `OrderApplicationModule` under `TemporalModule` or
`AmqpModule` and you have the worker and the consumer — one application, three
deployments.

## Packages

| Package                                                     | Description                                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@btravstack/core`](./packages/core)                       | The kernel: `start`, `runMain`, the lifecycle state machine, the unit-of-work registry, the `Runtime` contract, probes, exit codes.                                      |
| [`@btravstack/di`](./packages/di)                           | The container: ports, providers, modules, and wiring checked by the compiler. Depends on nothing but `unthrown`.                                                         |
| [`@btravstack/config`](./packages/config)                   | Configuration from the environment as providers: `Config.string/integer/port`, `Config.object`, `Config.provider`, `ConfigInvalid` → `78`.                               |
| [`@btravstack/testing`](./packages/testing)                 | The test harness: `bootFixture` for `test.extend`, `tapped` to read services out of a booted app, `testRuntime`, `createFakeClock`, `withApp`.                           |
| [`@btravstack/http-server`](./packages/http-server)         | The HTTP starter: oRPC over `node:http`, `OrpcRouter` / `HttpModule`, one unit per request, a drain that retires keep-alive connections.                                 |
| [`@btravstack/temporal-worker`](./packages/temporal-worker) | The Temporal starter: `TemporalActivities` / `TemporalWorkflowActivities` / `TemporalModule`, one unit per activity attempt, a drain that honours the kernel's deadline. |
| [`@btravstack/amqp-worker`](./packages/amqp-worker)         | The AMQP starter: `AmqpHandlers` / `AmqpHandler` / `AmqpModule`, one unit per delivery, one drain deadline.                                                              |
| [`@btravstack/contract`](./packages/contract)               | Contract-level markers a client and its server share: which schemes protect a route, and which scopes each must grant. Zero dependencies.                                |
| [`@btravstack/observability`](./packages/observability)     | Structured logging correlated with the ambient unit, a JSON sink, and OpenTelemetry traces and metrics behind their own subpath.                                         |
| [`@btravstack/prisma`](./packages/prisma)                   | The Prisma starter: `DATABASE_URL` through `Config`, a client whose pool is the application scope's, and a count and error line per query.                               |
| [`@btravstack/cache`](./packages/cache)                     | A `Cache` port with an in-memory adapter and a Redis one, instrumented by default.                                                                                       |
| [`@btravstack/mailer`](./packages/mailer)                   | A `Mailer` port with a recording adapter and an SMTP one, instrumented by default.                                                                                       |
| [`@btravstack/storage`](./packages/storage)                 | A `Storage` port with an in-memory adapter and an S3-compatible one with presigned reads.                                                                                |

## Examples

Ten small packages under [`./examples`](./examples) model one clean-architecture
order application — domain, application, infrastructure, three contracts —
booted under **three runtimes**: `order-api` answers over HTTP,
`order-temporal-worker` orchestrates, `order-amqp-worker` broadcasts every
committed write from a transactional outbox — and the same `DuplicateOrder`
becomes a typed `CONFLICT` on the first and a non-retryable contract error on
the second, with no mapping anywhere near the kernel. Plus the
container's own `di-hexagonal`, which never calls `start`. Each is
compiled, linted and tested by CI like a package. See the
[annotated walkthroughs](https://btravstack.github.io/btravstack/examples/).

## Contributing

This is a pnpm + turbo monorepo. The gate — every change keeps all six green,
and CI runs the same set:

```sh
pnpm install
pnpm format --check   # oxfmt (run without --check to auto-fix)
pnpm lint             # oxlint, incl. every @unthrown/oxlint rule
pnpm typecheck        # tsc, incl. the type-level *.test-d.ts files
pnpm knip             # dead code / unused deps
pnpm test             # vitest + v8 coverage (100% lines/functions on packages)
pnpm build            # tsdown dual CJS/ESM + d.ts
```

**The gate needs a running Docker daemon.** Six workspaces boot a real
dependency — a broker, a workflow platform, a database — and they share
**three containers** between them: one PostgreSQL, one RabbitMQ, one Temporal,
started once per machine and reused by every workspace's run
(`internal/test-infra`). Isolation is the boundary each system already has: a
**vhost** per test, a **namespace** per spec file, a **tenant** per test.
Measured: 27/27 tasks, about 32 s warm. Remove the containers with
`docker rm -f $(docker ps -aq --filter label=com.btravstack.test-infra)`.

Commits follow Conventional Commits; user-facing changes carry a changeset.
[`CLAUDE.md`](./CLAUDE.md) is the authoritative spec — the theses, the public
surface and the conventions, with the reasoning behind each.

## License

[MIT](./LICENSE) © Benoit TRAVERS
