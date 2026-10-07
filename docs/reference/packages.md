---
title: Packages and install
description: The fifteen published packages grouped by the job each does, who peers on what, and one install command per kind of deployment.
---

# Packages and install

> **Reference.** The fifteen published packages, grouped by the job each does,
> their peer-dependency matrix and the install command for each kind of
> deployment. For _why_ everything is a peer
> dependency, see [Peer dependencies](/explanation/peer-dependencies); for what
> a starter is, see [Starters](/explanation/starters).

## Five groups, and what to install first

The names carry the grouping, so a package's job is legible before you open
its page:

| Group                                          | Packages                                                | When you install one                                                                  |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Domain modelling**                           | `entity`                                                | When the application benefits from validated domain entities and aggregate decisions. |
| **The kernel and its plumbing**                | `core`, `di`, `config`, `contract`                      | Always — `core` boots the process, and the other three are what it boots.             |
| **Servers**, one per transport                 | `http-server`, `temporal-worker`, `amqp-worker`         | One, and exactly one: a process boots a single runtime.                               |
| **Capability ports**, a contract plus adapters | `observability`, `cache`, `mailer`, `storage`, `outbox` | When the application needs that capability. Each is independent of the others.        |
| **The harness**                                | `testing`                                               | As a dev dependency, always.                                                          |

**The shortest real application is `core` + `di` + `config` + one server.**
Everything else arrives when something needs it.

The three servers are named for the half they implement. `http-server` serves
an oRPC contract; `temporal-worker` and `amqp-worker` run the worker side of
their platforms — "worker" rather than "server" because that is those
ecosystems' own word, and because `temporal-server` already means the Temporal
Service itself. **The calling halves are not written yet**; when they are they
take `-client` names beside these, which is why the servers carry a qualifier
at all.

## The packages

| Package                       | What it is                                                                                                                                                                                                                                | Reference                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@btravstack/entity`          | A Zod-based domain model with sealed construction, derived request and response schemas, and Result-returning entry points. It has no dependency on the kernel.                                                                           | [Entity guide](/entity/), [Reference](/reference/entity/declaration), and [API](/api/entity/)                                                                                                    |
| `@btravstack/contract`        | The contract tier a client and a server share: `authenticated` says a procedure needs a principal, and a cursor page is one shape rather than two copies. The root depends on nothing; `zod` is optional, behind `/zod`.                  | [@btravstack/contract](/reference/contract)                                                                                                                                                      |
| `@btravstack/di`              | The container: ports as the vocabulary, providers bound at one edge, modules that declare their imports and exports. Depends on nothing.                                                                                                  | [Ports](/reference/di/ports), [Providers](/reference/di/providers), [Modules](/reference/di/modules), [Entry points](/reference/di/entry-points), [Wiring defects](/reference/di/wiring-defects) |
| `@btravstack/config`          | Configuration the twelve-factor way: `Env` as a port, typed fields bound from it through a schema, `ConfigInvalid` naming every fault.                                                                                                    | [@btravstack/config](/reference/config)                                                                                                                                                          |
| `@btravstack/core`            | The kernel: boot a module into a running process with one runtime, drain on SIGTERM, close the scope on every path, decide the exit code — and declare the `Logger`, `Tracer` and `Meter` ports the family implements elsewhere.          | [start](/reference/core/start), [RunningApp](/reference/core/running-app), [Runtime](/reference/core/runtime), [Exit codes](/reference/core/exit-codes)                                          |
| `@btravstack/cache`           | A `Cache` port, an in-memory adapter and a Redis one, and one composition that reports every call through `Observers`. A miss is `Ok(undefined)`; keys are yours.                                                                         | [@btravstack/cache](/reference/cache)                                                                                                                                                            |
| `@btravstack/mailer`          | A `Mailer` port, a recording adapter a spec asserts against and an SMTP one. `send` means accepted, not delivered; retries belong to your transport.                                                                                      | [@btravstack/mailer](/reference/mailer)                                                                                                                                                          |
| `@btravstack/storage`         | A `Storage` port, an in-memory adapter and an S3-compatible one with presigned reads and uploads (upload URLs can be reused until expiry). A missing object is an ordinary answer, not a fault.                                           | [@btravstack/storage](/reference/storage)                                                                                                                                                        |
| `@btravstack/prisma`          | A Prisma client whose pool is the application scope's: `DATABASE_URL` through `Config`, the Postgres driver adapter, and a resourceful provider. The client type stays yours — it is generated from your schema.                          | [@btravstack/prisma](/reference/prisma)                                                                                                                                                          |
| `@btravstack/outbox`          | The transactional outbox's relay: publishes committed facts in outbox order through a publisher you provide, with a per-tenant claim so replicas take turns rather than race for the same rows, a lag health check, and a Prisma 8 store. | [@btravstack/outbox](/reference/outbox)                                                                                                                                                          |
| `@btravstack/observability`   | The kernel's `Logger`, `Tracer` and `Meter` ports, implemented: a logger correlated with the ambient unit, a dependency-free JSON sink, pino behind one subpath and OpenTelemetry behind another, the kernel's events as lines.           | [@btravstack/observability](/reference/observability)                                                                                                                                            |
| `@btravstack/http-server`     | The HTTP starter: oRPC over `node:http`, one unit per request, `PORT`/`HOST` bound onto `HttpConfig`.                                                                                                                                     | [@btravstack/http-server](/reference/http-server)                                                                                                                                                |
| `@btravstack/temporal-worker` | The Temporal starter: a Worker as the runtime, one unit per activity attempt, a drain that honours the kernel's deadline.                                                                                                                 | [@btravstack/temporal-worker](/reference/temporal-worker)                                                                                                                                        |
| `@btravstack/amqp-worker`     | The AMQP starter: the handlers as a port, one unit per delivery, ack/nack/dead-letter routed by the contract.                                                                                                                             | [@btravstack/amqp-worker](/reference/amqp-worker)                                                                                                                                                |
| `@btravstack/testing`         | The test harness, a **dev dependency**: `bootFixture` boots and stops inside a vitest fixture, `tapped` reaches a running service, plus `testRuntime` and `createFakeClock`.                                                              | [@btravstack/testing](/reference/testing)                                                                                                                                                        |

`entity` is an optional domain-modelling library; applications can use it without the kernel, and the kernel never requires it.

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

| Package                       | Peers on                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@btravstack/entity`          | `zod`, `unthrown`, `@unthrown/standard-schema`                                                                                                                                                              |
| `@btravstack/di`              | `unthrown`                                                                                                                                                                                                  |
| `@btravstack/config`          | `@btravstack/di`, `unthrown`                                                                                                                                                                                |
| `@btravstack/core`            | `@btravstack/config`, `@btravstack/di`, `unthrown`                                                                                                                                                          |
| `@btravstack/observability`   | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `pino`, `@opentelemetry/api`, `@opentelemetry/sdk-node` as **optional** peers, each needed only by the subpath that imports it |
| `@btravstack/cache`           | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `redis` as an **optional** peer, behind the `/redis` subpath                                                                   |
| `@btravstack/mailer`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `nodemailer` as an **optional** peer, behind the `/smtp` subpath                                                               |
| `@btravstack/storage`         | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` as **optional** peers, behind the `/s3` subpath                         |
| `@btravstack/prisma`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@prisma/orm-postgres`                                                                                                              |
| `@btravstack/outbox`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `@prisma/orm-postgres` as an **optional** peer, behind the `/prisma` subpath                                                   |
| `@btravstack/contract`        | nothing required — and `zod` as an **optional** peer, behind the `/zod` subpath, so a client can take a contract without the server                                                                         |
| `@btravstack/http-server`     | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `@btravstack/contract`, `unthrown`, `@orpc/server`, `@orpc/contract`, `@unthrown/orpc`                                                          |
| `@btravstack/temporal-worker` | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`, `@temporal-contract/worker`, `@temporal-contract/contract`      |
| `@btravstack/amqp-worker`     | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@amqp-contract/worker`, `@opentelemetry/api`                                                                                       |
| `@btravstack/testing`         | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and **not** `vitest`: `bootFixture` is a plain `(ctx, use) => Promise<void>`, vitest's fixture protocol met without the import     |

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
`@btravstack/testing` and `@btravstack/observability` have **no runtime
dependencies** beyond `node:` builtins — the default log sink is
`JSON.stringify` and a `write`. `@btravstack/amqp-worker` peers on
`@opentelemetry/api` because `@amqp-contract/worker` imports it
unconditionally; `@amqp-contract/contract` is deliberately not in its list.

::: warning Prerelease peers
The HTTP, Temporal and AMQP starters peer on libraries whose next major is
still a prerelease: `@orpc/*`, `@temporal-contract/*` and
`@amqp-contract/worker`. Each library's `latest` dist-tag still points at its
previous major while the adapters here need the new one, so an unpinned range
resolves the old major and fails a strict peer check.

A prerelease can break between its own betas, so the commands below pin each
one to the **exact** version this repository's catalog tests, and an
application should keep them exact and move them only together with a
btravstack release.

Those numbers cannot drift from what is tested: `pnpm-workspace.yaml` is where
they live, each entry carrying its own comment, and the
[install-pin gate](https://github.com/btravstack/btravstack/blob/main/docs/scripts/check-install-pins.ts)
fails the docs build when a snippet's exact version differs from the catalog's.
:::

## Install

One command per kind of deployment. All of them assume the package manager
does not auto-install peers (`pnpm`'s `autoInstallPeers: false`); with one that
does, the first package alone suffices.

::: code-group

```sh [HTTP API]
pnpm add @btravstack/http-server @btravstack/core @btravstack/config @btravstack/di \
  @btravstack/contract unthrown @orpc/server@2.0.0-beta.28 @orpc/contract@2.0.0-beta.28 @unthrown/orpc@^0.2.0
```

```sh [Temporal worker]
pnpm add @btravstack/temporal-worker @btravstack/core @btravstack/config @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common \
  @temporal-contract/worker@8.0.0-beta.11 @temporal-contract/contract@8.0.0-beta.11
```

```sh [AMQP worker]
pnpm add @btravstack/amqp-worker @btravstack/core @btravstack/config @btravstack/di unthrown \
  @amqp-contract/worker@3.0.0-beta.11 @opentelemetry/api
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

Most published packages require Node `>=22`; `http-server` and `prisma`
require `>=22.12`, while `amqp-worker` and `temporal-worker` require
`>=22.22`. Each floor is checked against that package's required peers. The
repository's own development floor is `>=22.22`.

## Support and upgrades

This is the whole maintenance commitment, stated before you adopt:

- **Security fixes land on the latest published release only.** There are no
  backports, no long-term-support line and no commercial support — see the
  [security policy](https://github.com/btravstack/btravstack/blob/main/SECURITY.md).
- **Every published package shares one version number** and releases with the
  rest, changed or not, so `@btravstack/core@X` goes with every other package
  at `X`. Upgrade them together; never mix versions in one application.
- **Before 1.0, a minor release may break.** A patch is meant not to. Together
  with the two rules above, taking a security fix can mean moving the whole
  family through a breaking minor, prerelease peers included.
- **A release's notes are one page: its release pull request.** Each release
  is cut by merging a pull request that collects every package's changelog
  entry for that version — the
  [merged ones](https://github.com/btravstack/btravstack/pulls?q=is%3Apr+is%3Amerged+head%3Achangeset-release%2Fmain)
  are the release history, migration steps included, and the
  [open one](https://github.com/btravstack/btravstack/pulls?q=is%3Apr+is%3Aopen+head%3Achangeset-release%2Fmain)
  is what `main` carries that npm does not have yet. An entry sits under the
  package the change touched, so read the whole release, not only the packages
  you import. The same entries are in each package's `CHANGELOG.md` and its
  [GitHub release](https://github.com/btravstack/btravstack/releases).

This site is built from `main`, which can be ahead of npm; the version menu in
the navigation bar names the version this tree carries, says whether
unreleased changes are on it, and links npm's published versions to compare
against.

## Entry points

Every package's root specifier is its whole surface, and
[`/api/`](/api/) is the list to trust: it is **generated** from each package's
own `exports` map, so it cannot drift from what is published. Each package's
own reference page walks the same surface in prose.

What is worth stating here rather than derived is the **subpath** shape, since
a subpath is a decision a reader acts on: it exists so a heavy dependency can
stay an **optional peer** that a consumer who never imports it never installs.

| Subpath                                | What it holds                                   | The optional peer it keeps out       |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| `@btravstack/contract/zod`             | the cursor page's schema                        | `zod`                                |
| `@btravstack/observability/pino`       | `pinoSink`                                      | `pino`                               |
| `@btravstack/observability/otel`       | `otel`, `UnitSpanModule`                        | the `@opentelemetry/*` SDK           |
| `@btravstack/cache/redis`              | the Redis adapter                               | `redis`                              |
| `@btravstack/mailer/smtp`              | the SMTP adapter                                | `nodemailer`                         |
| `@btravstack/storage/s3`               | the S3 adapter                                  | the two `@aws-sdk` packages          |
| `@btravstack/prisma/rls`               | row-level security, pinned to the unit's tenant | —                                    |
| `@btravstack/outbox/prisma`            | the Prisma 8 store                              | `@prisma/orm-postgres`               |
| `@btravstack/http-server/openapi`      | `openApiDocument`                               | `@orpc/openapi`, `@orpc/json-schema` |
| `@btravstack/http-server/jwt`          | `jwtAuthenticator`                              | `jose`                               |
| `@btravstack/http-server/session`      | `sessionCodec`, `sessionAuthenticator`          | —                                    |
| `@btravstack/http-server/oidc`         | `oidc`, the login answerer                      | `openid-client`                      |
| `@btravstack/temporal-worker/schedule` | `ensureSchedule`                                | `@temporal-contract/client`          |
| `@btravstack/testing/jwt`              | `localIssuer`, the issuer a test signs with     | `jose`                               |

Two of those keep no peer out and are subpaths for a different reason: the
surface is separable and most graphs do not want it. `/session` is the cookie
half of authentication, and `/rls` is a policy a deployment opts into.

Published packages ship dual CJS/ESM builds with `.d.ts` files, except
`temporal-worker`, which is ESM-only because its required contract peer has
import-only subpaths. Tarballs carry no `src/`, so source maps would be a dead
end.
