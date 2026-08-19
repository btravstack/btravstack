---
title: Packages and install
description: The nine published packages, who peers on what, and one install command per kind of deployment.
---

# Packages and install

> **Reference.** The nine published packages, their peer-dependency matrix and the
> install command for each kind of deployment. For _why_ everything is a peer
> dependency, see [Peer dependencies](/explanation/peer-dependencies); for what
> a starter is, see [Starters](/explanation/starters).

## The packages

| Package                     | What it is                                                                                                                                                                                             | Reference                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@btravstack/contract`      | Contract-level markers a client and a server share: `authenticated` says a procedure needs a principal, and the handler's type carries it. Depends on nothing.                                         | [@btravstack/contract](/reference/contract)                                                                                                                                                      |
| `@btravstack/di`            | The container: ports as the vocabulary, providers bound at one edge, modules that declare their imports and exports. Depends on nothing.                                                               | [Ports](/reference/di/ports), [Providers](/reference/di/providers), [Modules](/reference/di/modules), [Entry points](/reference/di/entry-points), [Wiring defects](/reference/di/wiring-defects) |
| `@btravstack/config`        | Configuration the twelve-factor way: `Env` as a port, typed fields bound from it through a schema, `ConfigInvalid` naming every fault.                                                                 | [@btravstack/config](/reference/config)                                                                                                                                                          |
| `@btravstack/core`          | The kernel: boot a module into a running process with one runtime, drain on SIGTERM, close the scope on every path, decide the exit code.                                                              | [start](/reference/core/start), [RunningApp](/reference/core/running-app), [Runtime](/reference/core/runtime), [Exit codes](/reference/core/exit-codes)                                          |
| `@btravstack/observability` | Logging, as a starter: a strict `Logger` port correlated with the ambient unit, a dependency-free JSON sink, pino behind a subpath, the kernel's events as lines. Traces and metrics are not here yet. | [@btravstack/observability](/reference/observability)                                                                                                                                            |
| `@btravstack/http`          | The HTTP starter: oRPC over `node:http`, one unit per request, `PORT`/`HOST` bound onto `HttpConfig`.                                                                                                  | [@btravstack/http](/reference/http)                                                                                                                                                              |
| `@btravstack/temporal`      | The Temporal starter: a Worker as the runtime, one unit per activity attempt, a drain that honours the kernel's deadline.                                                                              | [@btravstack/temporal](/reference/temporal)                                                                                                                                                      |
| `@btravstack/amqp`          | The AMQP starter: the handlers as a port, one unit per delivery, ack/nack/dead-letter routed by the contract.                                                                                          | [@btravstack/amqp](/reference/amqp)                                                                                                                                                              |
| `@btravstack/testing`       | The test harness, a **dev dependency**: `bootFixture` boots and stops inside a vitest fixture, `tapped` reaches a running service, plus `testRuntime` and `createFakeClock`.                           | [@btravstack/testing](/reference/testing)                                                                                                                                                        |

The dependency direction is **`core` → `config` → `di`**, never back. `di`
depends on nothing in this workspace; `config` peers on `di`; `core` peers on
both; each starter peers on all three plus its own transport library —
`observability` is a starter with no transport library at all, so its three
peers are the only ones that are not optional; `testing` peers on `core`,
`config` and `di` and is installed as a dev dependency, so a production bundle
never pulls a fake in. Nothing here depends on a runtime package: the kernel
knows nothing about HTTP, AMQP or Temporal.

The `examples/` workspaces (`order-api`, `order-temporal-worker`,
`order-amqp-worker` and the rest) are **consumers, not fixtures**: they install
the packages the way an application would, run under the same gate as the
packages, and are not published. See [Examples](/examples/).

## Peer-dependency matrix

Every dependency between these packages is a **peer**, and so is every
third-party library a starter drives. An application installs each of them
once, so `di`'s port identity and `unthrown`'s `isResult` compare against a
single copy.

| Package                     | Peers on                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@btravstack/di`            | `unthrown`                                                                                                                                                                                              |
| `@btravstack/config`        | `@btravstack/di`, `unthrown`                                                                                                                                                                            |
| `@btravstack/core`          | `@btravstack/config`, `@btravstack/di`, `unthrown`                                                                                                                                                      |
| `@btravstack/observability` | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `pino`, the family's one **optional** peer, needed only by the `@btravstack/observability/pino` subpath                    |
| `@btravstack/contract`      | nothing — zero peers and zero dependencies, so a client can take a contract without the server                                                                                                          |
| `@btravstack/http`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `@btravstack/contract`, `unthrown`, `@orpc/server`, `@orpc/contract`, `@unthrown/orpc`                                                      |
| `@btravstack/temporal`      | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`, `@temporal-contract/worker`, `@temporal-contract/contract`  |
| `@btravstack/amqp`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@amqp-contract/worker`, `@opentelemetry/api`                                                                                   |
| `@btravstack/testing`       | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and **not** `vitest`: `bootFixture` is a plain `(ctx, use) => Promise<void>`, vitest's fixture protocol met without the import |

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
`@btravstack/testing` and `@btravstack/observability` have **no runtime
dependencies** beyond `node:` builtins — the default log sink is
`JSON.stringify` and a `write`. `@btravstack/amqp` peers on
`@opentelemetry/api` because `@amqp-contract/worker` imports it
unconditionally; `@amqp-contract/contract` is deliberately not in its list.

::: warning Two exact-beta pins
`@orpc/{client,contract,server}` are pinned to `2.0.0-beta.23` in this
repository's catalog: oRPC v2's `latest` dist-tag is still the 1.x line, while
`@unthrown/orpc` peers on `^2.0.0-beta`, so an unpinned range resolves 1.x and
fails a strict peer check. `@temporal-contract/*` are pinned to `8.0.0-beta.5`
for the same shape of reason (`latest` is 7.x, which peers on `unthrown@^4`).
Pin the same versions in an application until both go stable.
:::

## Install

One command per kind of deployment. All of them assume the package manager
does not auto-install peers (`pnpm`'s `autoInstallPeers: false`); with one that
does, the first package alone suffices.

::: code-group

```sh [HTTP API]
pnpm add @btravstack/http @btravstack/core @btravstack/config @btravstack/di \
  @btravstack/contract unthrown @orpc/server @orpc/contract @unthrown/orpc
```

```sh [Temporal worker]
pnpm add @btravstack/temporal @btravstack/core @btravstack/config @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common \
  @temporal-contract/worker @temporal-contract/contract
```

```sh [AMQP worker]
pnpm add @btravstack/amqp @btravstack/core @btravstack/config @btravstack/di unthrown \
  @amqp-contract/worker @opentelemetry/api
```

```sh [Kernel only]
pnpm add @btravstack/core @btravstack/config @btravstack/di unthrown
```

```sh [Logging]
pnpm add @btravstack/observability @btravstack/core @btravstack/config @btravstack/di unthrown
# and, only for the /pino subpath:
pnpm add pino
```

```sh [Testing]
pnpm add -D @btravstack/testing
```

```sh [Container only]
pnpm add @btravstack/di unthrown
```

:::

Every published package claims `engines: { node: ">=20" }`. The repository's
own development floor is higher (`>=22.19`); that is the toolchain's floor,
not a promise made to consumers.

::: info Not yet published
This repository has not cut a release, so there is nothing on npm to install
yet. The commands above are what they will be once it has.
:::

## Entry points

| Specifier                        | Contents                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@btravstack/core`               | `start`, `runMain`, `RuntimePort`, `RuntimeStartFailed`, `currentUnit`, `systemClock`, `stderrSink` and the types — see [start](/reference/core/start)                                                            |
| `@btravstack/testing`            | `bootFixture`, `tapped`, `testRuntime`, `TestRuntimePort`, `createFakeClock` and the types — a package of its own, so a production bundle never pulls the fakes in; see [@btravstack/testing](/reference/testing) |
| `@btravstack/config`             | `Env`, `Config`, `ConfigInvalid`, `ConfigFieldInvalid` and the types — see [@btravstack/config](/reference/config)                                                                                                |
| `@btravstack/di`                 | `Port`, `Provider`, `Module`, `Context` and the types — see [Ports](/reference/di/ports)                                                                                                                          |
| `@btravstack/contract`           | `auth`, `isAuthenticated`, `Authenticated`, `PrincipalKey`, `PrincipalOf` — see [@btravstack/contract](/reference/contract)                                                                                       |
| `@btravstack/observability`      | `Logger`, `createLogger`, `jsonSink`, `observability`, `LoggerConfig`, `logLevel`, `kernelEvents`, `LEVELS` and the types — see [@btravstack/observability](/reference/observability)                             |
| `@btravstack/observability/pino` | `pinoSink` alone, so `pino` stays an optional peer a consumer that never imports this never installs                                                                                                              |

All nine packages ship dual CJS/ESM builds with `.d.ts` files and no source
maps (the tarball carries no `src/`, so a map would be a dead end).
`@btravstack/observability` is the only one with a second entry point.
