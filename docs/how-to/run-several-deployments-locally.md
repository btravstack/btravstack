---
title: Run several deployments locally
description: One process per deployment in development too — turbo runs the API and both workers side by side, with prefixed output, watch on every file change, and the real drain on Ctrl-C.
---

# Run several deployments locally

> **How-to.** One application, three deployments, one command. For why a
> deployment is one runtime in the first place, see
> [One process, one runtime](/explanation/one-process-one-runtime); to boot an
> application from a test instead, see
> [Test an application](/how-to/test-an-application).

An application with an API, a Temporal worker and an AMQP consumer is three
deployments — three processes, each booting the same module under its own
composition root. Locally that would be three terminals. It is one command:

```sh
pnpm dev
```

That runs `turbo run dev --filter=./examples/*`, which brings up the shared
containers, applies the migrations, and starts all three entry points with
their output prefixed by workspace.

## Why processes rather than one runner

The obvious shortcut is to boot all three in **one** Node process, and the
kernel would let you — `start` returns a `RunningApp` and claims nothing about
the process, exactly so it can be embedded. It is still the wrong local loop,
for three reasons:

- **Watch.** Reloading a module graph in place means invalidating ESM modules
  Node will not let you re-import — a bespoke loader. One process per
  deployment gets watch from `tsx watch`, which is what makes the loop a loop.
- **Failure isolation.** Three applications in one process share an event
  loop and the process-global `uncaughtException` handlers, so one crash takes
  all three down and a blocking worker starves the API — neither of which can
  happen to three pods. A local loop that misrepresents failure isolation
  teaches the wrong lesson.
- **The drain.** Each process gets a real signal and runs its own three beats,
  which is the thing worth rehearsing locally.

So the shape is the production shape, with a watcher on top.

## What each piece is

**One `dev` script per deployment**, the entry point a container would run:

```json
{
  "scripts": {
    "dev": "PORT=0 PROBE_PORT=0 tsx watch --env-file=../../.env.dev src/main.ts"
  }
}
```

`tsx` because the repository's relative imports carry `.js` extensions
(`moduleResolution: NodeNext`), which Node's own type stripping does not remap
back to `.ts`. `--env-file` is Node's, not a `dotenv` dependency.

The inline variables are the ones that **must differ between deployments**,
and `PROBE_PORT` is the one that bites: it defaults to `9000` for every
application, so three deployments on one machine would mean two of them fail
to start with

```json
{
  "type": "startFailed",
  "cause": {
    "name": "RuntimeStartFailed",
    "message": "the probes runtime failed to start"
  }
}
```

**So both are `0` — bind an ephemeral port, and read back which one you got.**
`Config.port`'s floor is `0` precisely so this stays expressible, and the
`serving` event says what was bound:

```json
{
  "type": "serving",
  "runtime": "http",
  "info": { "port": 54312 },
  "probePort": 54313
}
```

Pinning `3000` and `9000`/`9001`/`9002` also broke the moment a second
**worktree** ran `pnpm dev`, which this repository does constantly: two
checkouts collide on all four ports. With the bound port on the event there is
nothing left to collide.

In production each pod has the port to itself, so `9000` is the right default,
and the local loop is what overrides it.

**`.env.dev`, generated rather than committed.** `pnpm dev` first runs
`internal/test-infra`'s `dev:env`, which starts the shared containers — the
very ones the test suites use, attached to rather than duplicated, via
testcontainers' `withReuse()` — applies the committed migrations with
`prisma migrate deploy`, and writes the addresses out:

```sh
DATABASE_URL=postgresql://orders_app:orders_app@localhost:55000/orders
AMQP_URL=amqp://guest:guest@localhost:55002
TEMPORAL_ADDRESS=localhost:55001
HTTP_JWT_JWKS_URI=http://localhost:55006/jwks.json
HTTP_JWT_ISSUER=https://dev.btravstack.test
HTTP_JWT_AUDIENCE=orders-api
```

The ports are whatever Docker mapped, which is precisely why they are written
to a file instead of defaulted in each application's config: an ephemeral
mapped port cannot be a default. Everything else each deployment needs already
has one.

The last three are the API's `user` scheme, which verifies a **real** OIDC
token — so the dev loop needs an issuer, and one of the containers is it: an
`nginx` serving a JWKS document over a key pair kept under
`<repo>/.cache/dev-issuer/`. The key is persisted rather than minted per run
because a token pasted into a terminal yesterday has to still verify today.

**A turbo task with the edges spelled out:**

```json
{
  "dev": {
    "dependsOn": [
      "^build",
      "^generate",
      "@btravstack/internal-test-infra#dev:env"
    ],
    "cache": false,
    "persistent": true
  }
}
```

`^generate` is what puts the Prisma client in place before anything imports
the repository, and the `dev:env` edge is what guarantees `.env.dev` exists
before a process tries to read it.

::: warning A dev loop needs Docker
The workspaces whose tests boot a broker, a database or a service already need
a daemon; the dev loop needs the same containers. They are started once per
machine and reused, so the second `pnpm dev` costs nothing.
:::

## Per-app configuration

Anything **shared** between the deployments goes in `.env.dev`, written once by
`dev:env`. Anything that **must differ** — `PROBE_PORT`, the API's `PORT` —
goes inline in that app's own `dev` script, as above; both are `0`, so what
differs is resolved at bind time rather than hand-assigned. To pin one anyway
— a stable port for a browser bookmark or a client sample — override it:

```sh
PORT=3001 pnpm --filter @btravstack/example-order-api dev
```

There is no config file format for the runner, because there is no runner —
the environment is the interface, exactly as it is in production.

## Calling the API

The `orders` fragment is marked, so an anonymous call is a `401` and never
reaches a use case. `pnpm dev:token` mints one the dev issuer signed:

```sh
# mint into a variable and check the status — never `$(…)` straight into the
# header, see below
TENANT=0199a1e0-0000-7000-8000-000000000001 # a UUIDv7
TOKEN=$(pnpm dev:token -- --tenant "$TENANT") || exit

# the port is the one the API's `serving` event logged, PORT=0 in its dev script
curl -s -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"json":{}}' \
     http://localhost:57234/rpc/orders/list
```

`--tenant` is required and must be a **UUIDv7**, because the application parses
the claim as one; `uuidgen` and `crypto.randomUUID()` both mint a v4, which
comes back as a `401` rather than as an error naming the mistake. `--sub`
defaults to `u-1` and `--scope` to `orders:export`.

**Mint into a variable, and check the status.** The script writes the token and
nothing else to stdout — but `pnpm` writes its own `[ELIFECYCLE]` line **to
stdout** when a script exits non-zero, and `--silent` does not suppress it, so
a `$(…)` composed straight into the header sends that line as the bearer token
on the very mistake the UUIDv7 check exists to catch.

## Watching a full drain

`tsx watch` force-kills its child **five seconds** after a signal, so it can
restart promptly on the next file change. The kernel's defaults are
`preDrainDelayMs: 5_000` followed by up to `drainTimeoutMs: 20_000`, so a
Ctrl-C under the watcher can be cut short before beat 3 finishes — you will
see `draining` and may not see `drained`.

That is the watcher's behaviour, not the kernel's. To watch a real drain end
to end, run the entry point without the watcher:

```sh
pnpm --filter @btravstack/example-order-api exec tsx src/main.ts
```

and send it a `SIGTERM`. The three beats then run in full:

```json
{ "event": "draining", "inFlight": 0 }
{ "event": "drained", "inFlightAtStart": 0, "completed": 0, "abandoned": 0 }
{ "event": "stopping" }
{ "event": "exited" }
```

The five seconds between the first two lines are beat 2 — the pre-drain delay
that exists because Kubernetes endpoint removal is eventually consistent. See
[Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes).

::: tip Two event shapes, and which one you are looking at
Those lines are `order-api`'s, which passes
`onEvent: kernelEvents(createLogger(jsonSink()))` — `@btravstack/observability`
renders each event with an `event` field and flattens the drain counters, so
the kernel's lines sit in the same stream as the application's own.

The two workers pass no `onEvent`, so they get the kernel's default
`stderrSink`, which writes the raw [`KernelEvent`](/reference/core/events) —
a `type` field, with the counters nested under `report`:

```json
{
  "type": "drained",
  "report": { "inFlightAtStart": 0, "completed": 0, "abandoned": 0 }
}
```

Same events, two renderings. Which you see is a property of the application's
composition root, not of the kernel.
:::

## Production is unchanged

Nothing here is a deployment shape. In production each of these three entry
points is its own container image, its own Deployment, its own replica count —
which is the whole point of
[one process, one runtime](/explanation/one-process-one-runtime). What the dev
loop borrows is only the watcher and the shared containers.
