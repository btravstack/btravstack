# @btravstack/internal-test-infra

The repository's shared test infrastructure. Private, never published, and not
an example of anything — it exists so the gate needs **one** of each server
rather than one per workspace.

## What it starts

| Container                          | Who uses it                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `postgres:18.1`                    | Temporal's own persistence, and the example application's `orders` database |
| `rabbitmq:4.2.1-management-alpine` | `packages/amqp-worker`, `examples/order-amqp-worker`                        |
| `temporalio/auto-setup:1.29.1`     | `packages/temporal-worker`, `examples/order-temporal-worker`                |
| `redis:8.8.2-alpine`               | `packages/cache`, `examples/order-api`                                      |
| `axllent/mailpit:v1.31.0`          | `packages/mailer`, `examples/order-amqp-worker`                             |
| `rustfs/rustfs:1.0.0-rc.3`         | `packages/storage`                                                          |
| `nginx:1.29-alpine`                | the dev loop's JWKS endpoint, and `src/dev-issuer.spec.ts`                  |

One container per backing service — the table above is the list, and the
workspaces reading each are in it. Before this existed, the broker and the
workflow platform were started per workspace instead: two RabbitMQ containers
and up to three Temporal time-skipping servers, and `pnpm test` was
intermittently red at turbo's
default concurrency because the 60s testcontainers startup wait was what gave
out first ([#52](https://github.com/btravstack/btravstack/issues/52)).

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
- **A key prefix per test.** A Redis test mints `test:<uuid>:` and writes
  under it, which is finer than a database index and, like every boundary
  here, needs no cleanup.
- **A recipient per test.** Mailpit delivers nowhere and keeps everything, so
  a UUID localpart is a mailbox nobody else reads — and one nobody has to
  purge.
- **A key prefix per test** in object storage too, inside one bucket: a bucket
  per test would be a create-and-delete round trip bought for an isolation a
  UUID prefix already gives for nothing.

## The `orders` database has two roles

The container's bootstrap user owns the schema and applies the migrations. It is
a **superuser**, and a superuser bypasses row security whatever
`FORCE ROW LEVEL SECURITY` says — so a policy exercised through it would pass
while proving nothing.

`provisionApplicationRole` therefore creates `orders_app`,
`NOSUPERUSER NOBYPASSRLS`, and grants it the whole `public` schema. That is the
role every `order-infrastructure` spec, both worker examples' fixtures and
`pnpm dev` connect as — `__ORDERS_DATABASE_URL__` and `.env.dev`'s
`DATABASE_URL` carry its credentials, and `DATABASE_URL` stays the one variable:
the owner's URL never leaves the setup that migrates with it.

It runs **after** `prisma migrate deploy`, because `ON ALL TABLES` covers only
what already exists; `ALTER DEFAULT PRIVILEGES` is what covers a table or
sequence a later migration adds. The grant on **sequences** is the one that
looks optional and is not: `Order.id` is `autoincrement()`, so without it every
insert fails with a permission error that reads nothing like an RLS refusal.

The DDL is idempotent — a `DO` block swallowing `duplicate_object`, and grants
that restate — because a reused container outlives the run and the role is
already there on the second one.

**A deployment's version of this DDL wants one more line, and this one does
not.** `GRANT … ON ALL TABLES` reaches `_prisma_migrations` like any other
table, so `orders_app` can rewrite the record of which migrations ran. Here that
is harmless — the setup migrates again on every run and the container is
disposable — but in production nothing the application does should be able to
touch it, so the DDL there ends with
`REVOKE ALL ON "_prisma_migrations" FROM orders_app;`. The reference page's copy
carries that line; see `docs/reference/prisma.md`.

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

| Import                                       | What it is                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@btravstack/internal-test-infra/rabbitmq`   | a vitest `globalSetup` providing `@amqp-contract/testing`'s inject keys                                                                                                                                |
| `@btravstack/internal-test-infra/temporal`   | a vitest `globalSetup` providing `@temporal-contract/testing`'s                                                                                                                                        |
| `@btravstack/internal-test-infra/containers` | `sharedPostgres` / `sharedRabbitMq` / `sharedTemporal` / `sharedRedis` / `sharedMailpit` / `sharedRustFs`, plus `postgresUrl`, `provisionApplicationRole` and the credentials each one is started with |
| `@btravstack/internal-test-infra/namespace`  | `createNamespace(address, prefix)`                                                                                                                                                                     |
| `@btravstack/internal-test-infra/lock`       | `withLock(name, run)`                                                                                                                                                                                  |

## The dev issuer

`order-api`'s `user` scheme verifies a **real** OIDC token against a real JWKS,
so the dev loop needs an issuer of its own — the specs use
`@btravstack/testing/jwt`'s in-process `localIssuer` and never come here.

`src/dev-issuer.ts` is that issuer, in three parts:

- **A key pair under `<repo>/.cache/dev-issuer/`** (`private.jwk` +
  `public.jwk`, RS256, `kid: "dev"`), minted on first use and read back for
  ever after. Persisted rather than minted per run for one reason: a token
  pasted into a terminal yesterday still verifies today, and a `pnpm dev:env`
  between the two changes nothing.
- **A container serving it.** `nginx:1.29-alpine` with
  `{ "keys": [publicJwk] }` copied in as `/jwks.json` — a real endpoint, so
  `jose`'s `createRemoteJWKSet` does a real fetch over the network. `dev:env`
  starts it beside the other six, and it carries the same
  `com.btravstack.test-infra` label. The key's RFC 7638 **thumbprint is one of
  its labels**, and labels are part of what testcontainers hashes for reuse: a
  new key pair therefore gets a new container rather than one still serving the
  old public half. The copied file could not express that on its own — content
  is copied after create and is not hashed — and the container the old key left
  behind goes with the `docker rm -f` above.
- **`signDevToken`**, behind `pnpm dev:token`.

```sh
# a tenant the dev loop already relays the outbox for
TENANT=0199a1e0-0000-7000-8000-000000000001 # a UUIDv7
pnpm dev:token -- --tenant "$TENANT"

# and the whole call, composed — the port is the one the `serving` event logged
curl -s -H "authorization: Bearer $(pnpm dev:token -- --tenant "$TENANT")" \
     -H 'content-type: application/json' -d '{"json":{}}' \
     http://localhost:57234/rpc/orders/list
```

`--tenant` is required and must be a **UUIDv7**: `principal` parses it with
`z.uuidv7()`, and `uuidgen` and `crypto.randomUUID()` both mint a v4, which
comes back as a 401 rather than as an error naming the mistake. Mint one with
`node -e 'import("uuidv7").then((m) => console.log(m.uuidv7()))'`, or reuse the
`OUTBOX_TENANTS` value above. `--sub` defaults to `u-1` and `--scope` to
`orders:export` (what `orders.export` requires; nothing else does). The token
and nothing else goes to stdout, which is what makes the `$(…)` above work; a
missing or malformed `--tenant` prints one line of usage on stderr and exits
`64`.

## The two scripts

Neither is an entry point. The first is `pnpm dev:env`
(`src/dev-env.ts`), which the repository's `pnpm dev` runs first. It starts the
same containers, applies the example application's migrations with
`prisma migrate deploy` under the same `withLock` its vitest `globalSetup`
uses, and writes the repository root's `.env.dev` — the addresses each example
process reads through Node's `--env-file`, the `HTTP_JWT_*` three the dev
issuer above supplies included. Same containers, attached to rather than
duplicated: a dev loop and a `pnpm test` can run side by side. `pnpm dev:token`
is the second, and needs nothing running but the JWKS container `dev:env`
started.

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

Every workspace that boots the example application or a broker-backed runtime
needs a daemon. A warm `pnpm test` attaches to what is already running, so the
image pulls are paid once per machine rather than once per run — which is the
property worth knowing; the wall clock is whatever your machine and your
concurrency make it.

## Not here: UUIDv7

The tenant fixtures need a real UUIDv7 — `crypto.randomUUID()` mints v4, which
`z.uuidv7()` rejects — and this package used to hand-roll one. It is the
[`uuidv7`](https://www.npmjs.com/package/uuidv7) package now, taken directly by
the four example workspaces that mint ids.

The hand-rolled fifteen lines were correct, and had a spec proving a thousand
minted ids were valid and distinct. What they did not have was a reason to
exist: the rule that makes this repository hand-roll `Config` rather than take
a schema library protects **consumers of published packages**, and this
workspace is `private` and reaches none. So the trade was fifteen lines of
RFC 9562 layout, verified once and unlikely to be read again, against a
zero-dependency package that also orders ids minted within the same
millisecond — which nothing needs today.
