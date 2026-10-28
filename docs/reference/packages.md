---
title: Packages and install
description: The twenty-six published packages grouped by the job each does, who peers on what, and one install command per kind of deployment.
---

# Packages and install

> **Reference.** The twenty-six published packages, grouped by the job each does,
> their peer-dependency matrix and the install command for each kind of
> deployment. For _why_ everything is a peer
> dependency, see [Peer dependencies](/explanation/peer-dependencies); for what
> a starter is, see [Starters](/explanation/starters).

## Seven groups, and what to install first

The names carry the grouping, so a package's job is legible before you open
its page:

| Group                                          | Packages                                                               | When you install one                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Domain modelling**                           | `entity`                                                               | When the application benefits from validated domain entities and aggregate decisions.            |
| **The kernel and its plumbing**                | `core`, `di`, `config`, `contract`                                     | Always — `core` boots the process, and the other three are what it boots.                        |
| **Runtime servers**                            | `http-server`, `temporal-worker`, `amqp-worker`                        | One, and exactly one: a process boots a single runtime.                                          |
| **Capability ports**, a contract plus adapters | `observability`, `cache`, `mailer`, `storage`, `keys`, `outbox`        | When the application needs that capability. Each is independent of the others.                   |
| **HTTP answerers**                             | `orpc-server`, `htmx-server`, `graphql-server`, `mcp-server`, `pothos` | Add the protocols this deployment serves; `pothos` builds a GraphQL schema over oRPC procedures. |
| **Outbound clients**                           | `temporal-client`, `amqp-client`, `http-client`, `oauth-client`        | Bind a typed remote client to the application scope without its worker, or a token to call as.   |
| **The harness**                                | `testing`, `temporal-testing`                                          | As dev dependencies: `testing` always, `temporal-testing` when specs need a Temporal server.     |

**The shortest real application is `core` + `di` + `config` + one server.**
Everything else arrives when something needs it.

The three servers are named for the half they implement. `http-server` owns the Node listener; `orpc-server` serves an oRPC contract; `temporal-worker` and `amqp-worker` run the worker side of
their platforms — "worker" rather than "server" because that is those
ecosystems' own word, and because `temporal-server` already means the Temporal
Service itself. The AMQP and Temporal calling halves have their own `-client`
packages, so an outbound caller does not install a worker.

## The packages

| Package                        | What it is                                                                                                                                                                                                                                                                          | Reference                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@btravstack/entity`           | A Zod-based domain model with sealed construction, derived request and response schemas, and Result-returning entry points. It has no dependency on the kernel.                                                                                                                     | [Entity guide](/entity/), [Reference](/reference/entity/declaration), and [API](/api/entity/)                                                                                                    |
| `@btravstack/contract`         | The contract tier a client and a server share: `authenticated` says a procedure needs a principal, and a cursor page is one shape rather than two copies. The root depends on nothing; `zod` is optional, behind `/zod`.                                                            | [@btravstack/contract](/reference/contract)                                                                                                                                                      |
| `@btravstack/di`               | The container: ports as the vocabulary, providers bound at one edge, modules that declare their imports and exports. Depends on nothing.                                                                                                                                            | [Ports](/reference/di/ports), [Providers](/reference/di/providers), [Modules](/reference/di/modules), [Entry points](/reference/di/entry-points), [Wiring defects](/reference/di/wiring-defects) |
| `@btravstack/config`           | Configuration the twelve-factor way: `Env` as a port, typed fields bound from it through a schema, `ConfigInvalid` naming every fault.                                                                                                                                              | [@btravstack/config](/reference/config)                                                                                                                                                          |
| `@btravstack/core`             | The kernel: boot a module into a running process with one runtime, drain on SIGTERM, close the scope on every path, decide the exit code — and declare the `Logger`, `Tracer` and `Meter` ports the family implements elsewhere.                                                    | [start](/reference/core/start), [RunningApp](/reference/core/running-app), [Runtime](/reference/core/runtime), [Exit codes](/reference/core/exit-codes)                                          |
| `@btravstack/cache`            | A `Cache` port, an in-memory adapter and a Redis one, and one composition that reports every call through `Observers`. A miss is `Ok(undefined)`; keys are yours.                                                                                                                   | [@btravstack/cache](/reference/cache)                                                                                                                                                            |
| `@btravstack/mailer`           | A `Mailer` port, a recording adapter a spec asserts against and an SMTP one. `send` means accepted, not delivered; retries belong to your transport.                                                                                                                                | [@btravstack/mailer](/reference/mailer)                                                                                                                                                          |
| `@btravstack/storage`          | A `Storage` port, an in-memory adapter and an S3-compatible one with presigned reads and uploads (upload URLs can be reused until expiry). A missing object is an ordinary answer, not a fault.                                                                                     | [@btravstack/storage](/reference/storage)                                                                                                                                                        |
| `@btravstack/keys`             | An `EnvelopeKeys` port: a root key per owner in generations, wrapped by an AWS KMS key of that owner, unwrapped in memory and cached for a TTL, erased with one key deletion, and an HKDF helper giving each purpose its own key.                                                   | [@btravstack/keys](/reference/keys)                                                                                                                                                              |
| `@btravstack/prisma`           | A Prisma client whose pool is the application scope's: `DATABASE_URL` through `Config`, the Postgres driver adapter, and a resourceful provider. The client type stays yours — it is generated from your schema.                                                                    | [@btravstack/prisma](/reference/prisma)                                                                                                                                                          |
| `@btravstack/outbox`           | The transactional outbox's relay: publishes committed facts in outbox order through a publisher you provide, with a per-tenant claim so replicas take turns rather than race for the same rows, a lag health check, and a Prisma 8 store.                                           | [@btravstack/outbox](/reference/outbox)                                                                                                                                                          |
| `@btravstack/observability`    | The kernel's `Logger`, `Tracer` and `Meter` ports, implemented: a logger correlated with the ambient unit, a dependency-free JSON sink, pino behind one subpath and OpenTelemetry behind another, the kernel's events as lines.                                                     | [@btravstack/observability](/reference/observability)                                                                                                                                            |
| `@btravstack/http-server`      | The protocol-neutral Node HTTP runtime, one unit per request, `PORT`/`HOST` bound onto `HttpConfig`.                                                                                                                                                                                | [@btravstack/http-server](/reference/http-server)                                                                                                                                                |
| `@btravstack/orpc-server`      | The oRPC answerer, `defineHttp`, `HttpModule`, and OpenAPI routes.                                                                                                                                                                                                                  | [Serve oRPC](/how-to/serve-orpc-over-http)                                                                                                                                                       |
| `@btravstack/htmx-server`      | Escaped HTML fragments under the HTTP runtime.                                                                                                                                                                                                                                      | [Serve fragments](/how-to/serve-htmx-fragments)                                                                                                                                                  |
| `@btravstack/graphql-server`   | Yoga answerer for any `GraphQLSchema`, with explicit GraphQL peers.                                                                                                                                                                                                                 | [Serve GraphQL](/how-to/serve-graphql)                                                                                                                                                           |
| `@btravstack/mcp-server`       | A Model Context Protocol answerer over the official SDK: Streamable HTTP, stateless, authenticated through the shared schemes, one unit per request, and `toolResult` turning a tool's `Result` into its answer.                                                                    | [Serve MCP](/how-to/serve-mcp)                                                                                                                                                                   |
| `@btravstack/pothos`           | A Pothos plugin whose fields call oRPC procedures: input validated by the procedure's contract, each declared error a typed member of the field's union, access refusals GraphQL's own error. Depends on no other package here.                                                     | [Resolve GraphQL fields from oRPC](/how-to/resolve-graphql-fields-from-orpc)                                                                                                                     |
| `@btravstack/temporal-worker`  | The Temporal starter: a Worker as the runtime, one unit per activity attempt, a drain that honours the kernel's deadline.                                                                                                                                                           | [@btravstack/temporal-worker](/reference/temporal-worker)                                                                                                                                        |
| `@btravstack/amqp-worker`      | The AMQP starter: the handlers as a port, one unit per delivery, ack/nack/dead-letter routed by the contract.                                                                                                                                                                       | [@btravstack/amqp-worker](/reference/amqp-worker)                                                                                                                                                |
| `@btravstack/temporal-client`  | Scoped connection and typed Temporal client providers.                                                                                                                                                                                                                              | [@btravstack/temporal-client](/reference/temporal-client)                                                                                                                                        |
| `@btravstack/http-client`      | Policy-bound outbound HTTPS with application-approved origins and bounded responses.                                                                                                                                                                                                | [@btravstack/http-client](/reference/http-client)                                                                                                                                                |
| `@btravstack/oauth-client`     | A `TokenSource` port over the OAuth 2.0 client credentials grant, so a service calls another as itself: a token kept per audience until shortly before it expires, one fetch shared by concurrent callers, and a static adapter for tests.                                          | [@btravstack/oauth-client](/reference/oauth-client)                                                                                                                                              |
| `@btravstack/amqp-client`      | Scoped typed AMQP client provider.                                                                                                                                                                                                                                                  | [@btravstack/amqp-client](/reference/amqp-client)                                                                                                                                                |
| `@btravstack/testing`          | The test harness, a **dev dependency**: `bootFixture` boots and stops inside a vitest fixture, `tapped` reaches a running service, plus `testRuntime` and `createFakeClock`.                                                                                                        | [@btravstack/testing](/reference/testing)                                                                                                                                                        |
| `@btravstack/temporal-testing` | A Temporal server for specs, a **dev dependency**: a Vitest `globalSetup` starting the CLI's development server once per Docker host, reused across processes, and a fixture registering a namespace per spec file. Serves `temporal-worker` and `temporal-client` consumers alike. | [@btravstack/temporal-testing](/reference/temporal-testing)                                                                                                                                      |

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

| Package                        | Peers on                                                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@btravstack/entity`           | `zod`, `unthrown`, `@unthrown/standard-schema`                                                                                                                                                                                                 |
| `@btravstack/di`               | `unthrown`                                                                                                                                                                                                                                     |
| `@btravstack/config`           | `@btravstack/di`, `unthrown`                                                                                                                                                                                                                   |
| `@btravstack/core`             | `@btravstack/config`, `@btravstack/di`, `unthrown`                                                                                                                                                                                             |
| `@btravstack/observability`    | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `pino`, `@opentelemetry/api`, `@opentelemetry/sdk-node` as **optional** peers, each needed only by the subpath that imports it                                    |
| `@btravstack/cache`            | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `redis` as an **optional** peer, behind the `/redis` subpath                                                                                                      |
| `@btravstack/mailer`           | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `nodemailer` as an **optional** peer, behind the `/smtp` subpath                                                                                                  |
| `@btravstack/storage`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` as **optional** peers, behind the `/s3` subpath                                                            |
| `@btravstack/keys`             | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `@aws-sdk/client-kms` as an **optional** peer, behind the `/kms` subpath                                                                                          |
| `@btravstack/prisma`           | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@prisma/orm-postgres`                                                                                                                                                 |
| `@btravstack/outbox`           | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and `@prisma/orm-postgres` as an **optional** peer, behind the `/prisma` subpath                                                                                      |
| `@btravstack/contract`         | nothing required — and `zod` as an **optional** peer, behind the `/zod` subpath, so a client can take a contract without the server                                                                                                            |
| `@btravstack/http-server`      | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `@btravstack/contract`, `unthrown`; `jose` and `openid-client` remain optional for auth subpaths                                                                                   |
| `@btravstack/orpc-server`      | `@btravstack/http-server`, `@btravstack/htmx-server`, `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `@btravstack/contract`, `unthrown`, `@orpc/server`, `@orpc/contract`, `@orpc/openapi`, `@orpc/json-schema`, `@unthrown/orpc` |
| `@btravstack/htmx-server`      | `@btravstack/http-server`, `@btravstack/core`, `@btravstack/di`, `@btravstack/contract`, `unthrown`                                                                                                                                            |
| `@btravstack/graphql-server`   | `@btravstack/http-server`, `@btravstack/di`, `@btravstack/contract`, `unthrown`, `graphql`, `graphql-yoga`                                                                                                                                     |
| `@btravstack/mcp-server`       | `@btravstack/http-server`, `@btravstack/core`, `@btravstack/di`, `@btravstack/contract`, `unthrown`, `@modelcontextprotocol/sdk` — and `zod`, the SDK's own required peer                                                                      |
| `@btravstack/pothos`           | `@pothos/core`, `@pothos/plugin-errors`, `@pothos/plugin-relay`, `@unthrown/pothos`, `graphql`, `@orpc/contract`, `@orpc/client`, `zod`, `unthrown`                                                                                            |
| `@btravstack/temporal-worker`  | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`, `@temporal-contract/worker`, `@temporal-contract/contract`                                         |
| `@btravstack/amqp-worker`      | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`, `@amqp-contract/worker`, `@opentelemetry/api`                                                                                                                          |
| `@btravstack/temporal-client`  | `@btravstack/di`, `@temporal-contract/client`, `@temporal-contract/contract`, `@temporalio/client`, `@temporalio/common`, `unthrown`                                                                                                           |
| `@btravstack/http-client`      | `@btravstack/core`, `@btravstack/di`, `unthrown`                                                                                                                                                                                               |
| `@btravstack/oauth-client`     | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `openid-client`, `unthrown`                                                                                                                                                        |
| `@btravstack/amqp-client`      | `@btravstack/di`, `@amqp-contract/client`, `@opentelemetry/api`, `unthrown`                                                                                                                                                                    |
| `@btravstack/testing`          | `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown` — and **not** `vitest`: `bootFixture` is a plain `(ctx, use) => Promise<void>`, vitest's fixture protocol met without the import                                        |
| `@btravstack/temporal-testing` | `@temporalio/client`, `@temporalio/common`, `testcontainers`, `vitest` — no `@btravstack/*` package, so a worker's and a client's specs install the same one                                                                                   |

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
`@btravstack/testing` and `@btravstack/observability` have **no runtime
dependencies** beyond `node:` builtins — the default log sink is
`JSON.stringify` and a `write`. `@btravstack/amqp-worker` peers on
`@opentelemetry/api` because `@amqp-contract/worker` imports it
unconditionally; `@amqp-contract/contract` is deliberately not in its list.

::: warning Prerelease peers
The HTTP, Temporal and AMQP starters, and `pothos`, peer on libraries whose next major is
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
pnpm add @btravstack/http-server @btravstack/orpc-server @btravstack/htmx-server \
  @btravstack/core @btravstack/config @btravstack/di @btravstack/contract unthrown \
  @orpc/server@2.0.0-beta.44 @orpc/contract@2.0.0-beta.44 \
  @orpc/openapi@2.0.0-beta.44 @orpc/json-schema@2.0.0-beta.44 \
  @orpc/client@2.0.0-beta.44 @unthrown/orpc@^0.4.2
```

```sh [GraphQL gateway]
pnpm add @btravstack/http-server @btravstack/graphql-server @btravstack/core \
  @btravstack/config @btravstack/di @btravstack/contract unthrown graphql@^17.0.0 graphql-yoga@^5.24.1
```

```sh [GraphQL over oRPC]
pnpm add @btravstack/http-server @btravstack/graphql-server @btravstack/core \
  @btravstack/config @btravstack/di @btravstack/contract unthrown graphql@^17.0.0 graphql-yoga@^5.24.1 \
  @btravstack/pothos @pothos/core @pothos/plugin-errors @pothos/plugin-relay \
  @unthrown/pothos@^0.1.2 zod @orpc/client@2.0.0-beta.44 @orpc/contract@2.0.0-beta.44
```

```sh [Temporal worker]
pnpm add @btravstack/temporal-worker @btravstack/core @btravstack/config @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common \
  @temporal-contract/worker@8.0.0-beta.15 @temporal-contract/contract@8.0.0-beta.15
```

```sh [AMQP worker]
pnpm add @btravstack/amqp-worker @btravstack/core @btravstack/config @btravstack/di unthrown \
  @amqp-contract/worker@3.0.0-beta.12 @opentelemetry/api
```

```sh [Temporal client]
pnpm add @btravstack/temporal-client @btravstack/di unthrown \
  @temporal-contract/client@8.0.0-beta.15 @temporal-contract/contract@8.0.0-beta.15 \
  @temporalio/client @temporalio/common
```

```sh [AMQP client]
pnpm add @btravstack/amqp-client @btravstack/di unthrown \
  @amqp-contract/client@3.0.0-beta.12 @opentelemetry/api
```

```sh [Calling as a service]
pnpm add @btravstack/oauth-client @btravstack/core @btravstack/config @btravstack/di \
  openid-client unthrown
```

```sh [Envelope keys]
pnpm add @btravstack/keys @btravstack/core @btravstack/config @btravstack/di unthrown
# and, only for the /kms subpath:
pnpm add @aws-sdk/client-kms
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
# and, for specs that need a Temporal server:
pnpm add -D @btravstack/temporal-testing testcontainers vitest @temporalio/client @temporalio/common
```

```sh [Container only]
pnpm add @btravstack/di unthrown
```

:::

Most published packages require Node `>=22`; `http-server`, `prisma`,
`oauth-client` and `mcp-server` require `>=22.12`; `graphql-server` requires `>=22.15`, while `amqp-worker`,
`temporal-worker`, `amqp-client`, `temporal-client` and `temporal-testing` require `>=22.22`.
Each floor is checked against that package's required peers. The
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

| Subpath                                | What it holds                                   | The optional peer it keeps out           |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| `@btravstack/contract/zod`             | the cursor page's schema                        | `zod`                                    |
| `@btravstack/observability/pino`       | `pinoSink`                                      | `pino`                                   |
| `@btravstack/observability/otel`       | `otel`, `UnitSpanModule`                        | the `@opentelemetry/*` SDK               |
| `@btravstack/cache/redis`              | the Redis adapter                               | `redis`                                  |
| `@btravstack/mailer/smtp`              | the SMTP adapter                                | `nodemailer`                             |
| `@btravstack/storage/s3`               | the S3 adapter                                  | the two `@aws-sdk` packages              |
| `@btravstack/keys/kms`                 | `kmsKeys`, the AWS KMS adapter                  | `@aws-sdk/client-kms`                    |
| `@btravstack/prisma/rls`               | row-level security, pinned to the unit's tenant | —                                        |
| `@btravstack/outbox/prisma`            | the Prisma 8 store                              | `@prisma/orm-postgres`                   |
| `@btravstack/orpc-server/openapi`      | `openApiDocument`                               | included as required `orpc-server` peers |
| `@btravstack/http-server/jwt`          | `jwtAuthenticator`                              | `jose`                                   |
| `@btravstack/http-server/session`      | `sessionCodec`, `sessionAuthenticator`          | —                                        |
| `@btravstack/http-server/oidc`         | `oidc`, the login answerer                      | `openid-client`                          |
| `@btravstack/temporal-worker/schedule` | `ensureSchedule`                                | `@temporal-contract/client`              |
| `@btravstack/testing/jwt`              | `localIssuer`, the issuer a test signs with     | `jose`                                   |

Two of those keep no peer out and are subpaths for a different reason: the
surface is separable and most graphs do not want it. `/session` is the cookie
half of authentication, and `/rls` is a policy a deployment opts into.

Published packages ship dual CJS/ESM builds with `.d.ts` files, except
`temporal-worker`, which is ESM-only because its required contract peer has
import-only subpaths, `temporal-testing`, which is ESM-only because its
required `vitest` peer is, and `pothos`, which is ESM-only because its required
`@orpc/client` peer is. Tarballs carry no `src/`, so source maps would be a dead
end.
