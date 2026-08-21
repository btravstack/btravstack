<div align="center">

# start

**The application kernel for [TypeScript](https://www.typescriptlang.org/):
boot a dependency-injection module into a running process, and stop it again
without losing work.**

[![CI](https://github.com/btravstack/start/actions/workflows/ci.yml/badge.svg)](https://github.com/btravstack/start/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40btravstack%2Fcore.svg?logo=npm)](https://www.npmjs.com/package/@btravstack/core)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**Documentation**](https://btravstack.github.io/start/) · [**Get Started**](https://btravstack.github.io/start/tutorial/getting-started) · [**Why start?**](https://btravstack.github.io/start/explanation/why-start)

</div>

An application is a [`@btravstack/di`](./packages/di) module: ports, providers,
and a wiring the compiler has already proven. `start` owns **when** that graph
is built and torn down — one lifecycle state machine, one unit-of-work
registry, one `Runtime` contract — and a **starter** brings the transport: HTTP
through oRPC, a Temporal worker, an AMQP consumer. The kernel knows none of
them by name.

## Why start?

Every backend process gets the same things wrong on its own: it stops
accepting the instant SIGTERM lands and rejects the traffic Kubernetes is
still routing to it; its readiness probe answers from a transport rather than
from its state; a failed finaliser is logged and forgotten; a crash exits `0`.
`start` gets them right once, as defaults.

- 🧩 **Business code only.** A composition root is a
  `HttpModule("OrdersApi")({
needs: [Env], router, imports, exports })` and a `main.ts` is
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

See [Why start?](https://btravstack.github.io/start/explanation/why-start) for
what it is not — NestJS's `NestFactory.create`, an Effect runtime, a
full-stack framework — and how it compares to a hand-rolled `main.ts`.

## Install

```sh
pnpm add @btravstack/core @btravstack/config @btravstack/di unthrown
```

For an HTTP API add the starter and its peers:

```sh
pnpm add @btravstack/http @orpc/server @orpc/contract @unthrown/orpc
```

Everything is a **peer dependency** — the application holds one copy of each,
which is what keeps port identity and `isResult` honest across packages. The
kernel and `@btravstack/config` depend on `node:` builtins only. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The commands above are what they will be once it has.

## Quick example

An HTTP API is a contract, a router that implements it from the use cases it
declares, and a composition root. This is
[`examples/order-api`](./examples/order-api)'s **orders slice**, served on its
own and condensed to one procedure — the example itself composes that slice
and a `customers` one into a single router through controllers:

```ts
// contract.ts — declared before any implementation exists; a client needs only this.
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

```ts
// router.ts — one Result-returning function per procedure, typed by the contract.
import { HttpRouter } from "@btravstack/http";
import { P } from "unthrown";

export const ordersRouter = HttpRouter(ordersContract)(
  { place: PlaceOrder },
  {
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
  },
);
```

```ts
// main.ts — the whole process.
import { runMain } from "@btravstack/core";
import { HttpModule } from "@btravstack/http";

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

| Package                                       | Description                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@btravstack/core`](./packages/core)         | The kernel: `start`, `runMain`, the lifecycle state machine, the unit-of-work registry, the `Runtime` contract, probes, exit codes.                                      |
| [`@btravstack/di`](./packages/di)             | The container: ports, providers, modules, and wiring checked by the compiler. Depends on nothing but `unthrown`.                                                         |
| [`@btravstack/config`](./packages/config)     | Configuration from the environment as providers: `Config.string/integer/port`, `Config.object`, `Config.provider`, `ConfigInvalid` → `78`.                               |
| [`@btravstack/testing`](./packages/testing)   | The test harness: `bootFixture` for `test.extend`, `tapped` to read services out of a booted app, `testRuntime`, `createFakeClock`, `withApp`.                           |
| [`@btravstack/http`](./packages/http)         | The HTTP starter: oRPC over `node:http`, `HttpRouter` / `HttpModule`, one unit per request, a drain that retires keep-alive connections.                                 |
| [`@btravstack/temporal`](./packages/temporal) | The Temporal starter: `TemporalActivities` / `TemporalWorkflowActivities` / `TemporalModule`, one unit per activity attempt, a drain that honours the kernel's deadline. |
| [`@btravstack/amqp`](./packages/amqp)         | The AMQP starter: `AmqpHandlers` / `AmqpHandler` / `AmqpModule`, one unit per delivery, one drain deadline.                                                              |

## Examples

Ten small packages under [`./examples`](./examples) model one clean-architecture
order application — domain, application, infrastructure, three contracts —
booted under **three runtimes**: `order-api` answers over HTTP,
`order-temporal-worker` orchestrates, `order-amqp-worker` broadcasts every
committed write from a transactional outbox — and the same `DuplicateOrder`
becomes a typed `CONFLICT` on the first and a non-retryable contract error on
the second, with no mapping anywhere near the kernel. Plus the
container's own `hexagonal-order-api`, which never calls `start`. Each is
compiled, linted and tested by CI like a package. See the
[annotated walkthroughs](https://btravstack.github.io/start/examples/).

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
