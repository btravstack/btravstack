---
title: Temporal testing
description: A Temporal server for the specs of temporal-worker and temporal-client consumers — one development server per Docker host, reused across processes, and a namespace per spec file.
---

# `@btravstack/temporal-testing`

What a consumer's own specs run a Temporal worker or client against.
[Test a Temporal worker](/how-to/test-a-temporal-worker) is the recipe. The
package peers on no `@btravstack/*` package, so the specs of a
`@btravstack/temporal-worker` deployment and of a
`@btravstack/temporal-client` caller install the same one, as a **dev
dependency**.

| Export                  | Kind  | What it is                                                                                                                                                                                                                                |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temporalServer`        | value | `temporalServer({ startupTimeoutMs?, reuse? })` — a Vitest `globalSetup` starting one `temporalio/temporal:1.9.1` container (`server start-dev`, in memory) and providing its address                                                     |
| default export          | value | `temporalServer()`, so `globalSetup: ["@btravstack/temporal-testing"]` is the whole configuration                                                                                                                                         |
| `TemporalServerOptions` | type  | `{ readonly startupTimeoutMs?: number; readonly reuse?: boolean }` — the container's health-check start period, retry count and `testcontainers` wait (default `60_000`), and reuse (default `true`)                                      |
| `temporalEnvironment`   | value | `temporalEnvironment(prefix = "spec")` — a file-scoped `test.extend` fixture registering `<prefix>-<uuid>` and answering a `TemporalEnvironment` once every Temporal service can use it                                                   |
| `temporalNamespace`     | value | `temporalNamespace(address, prefix = "spec")` — registers `<prefix>-<uuid>` on the server at `address` and resolves to its name once every Temporal service can use it, with no test context, so a `globalSetup` can register one per run |
| `TemporalEnvironment`   | type  | `{ readonly TEMPORAL_ADDRESS: string; readonly TEMPORAL_NAMESPACE: string }` — spread into `start`'s or `boot`'s `env`, or read by a client's settings                                                                                    |

## The server

The image is the Temporal CLI's development server: one container, its
state in memory, no database and no schema step. A pinned image is the whole
download, so a run needs no network beyond the image pull, unlike Temporal's
time-skipping test server, which fetches a binary on first use. It serves
everything the starters' own specs use: namespaces, visibility listing and
schedules.

**`reuse: true`, the default, gives one server per Docker host.**
`testcontainers`' `withReuse()` attaches a run to the container an earlier
run started, so a monorepo whose workflow suites run as separate Vitest
processes starts one server rather than one per suite. The container also
carries a fixed name derived from the image, `startupTimeoutMs` and the
installed `testcontainers` version. `testcontainers`' reuse lock is
per-process, so concurrent first runs all miss the lookup and try to create
one. Docker accepts the first create with that name and refuses the others.
Each refused run tries again, its pause doubling from 100 ms to 1 s, until
`startupTimeoutMs` has passed, and attaches to the winner's container as soon
as Docker lists it, which a loaded host can take seconds to do. A reused
container is not registered with the `testcontainers` reaper, so it outlives the run and the next run attaches in
well under a second. Remove it with:

```sh
docker rm -f $(docker ps -aq --filter name=btravstack-temporal-)
```

**`reuse: false` owns the server**: an unnamed container for this run alone,
stopped by the setup's teardown at the run's end. The setup behaves this way
whatever `reuse` says when `TESTCONTAINERS_REUSE_ENABLE=false` is set, since
`testcontainers` then reaps every container at exit anyway.

A failure is the run's: the setup rejects with the container's own error, and
`testcontainers` removes a container that never became healthy.

## The namespace

**A spec file is isolated by its namespace, never by its task queue.** The
starter reads its queue off the contract, so two files booting one worker poll
one queue, and suites sharing a server's `default` namespace see each other's
workflows as soon as they list them. `temporalEnvironment` registers a fresh
namespace per file and retries a namespace-scoped read until it answers, so a
namespace that never becomes usable fails the file, its error naming the
namespace. Nothing is cleaned up: the namespace lives as long as the server.

**A run whose workers a `globalSetup` starts gets one namespace for the run.**
Workers started once and shared across spec files cannot take a namespace per
file, and must not poll `default`, where every run on the shared server
would take the others' tasks. `temporalNamespace(address, prefix)` is the
registration the fixture uses, with neither `inject` nor `vi`: a setup reads
the address with `project.getProvidedContext()`, registers, starts its
workers in that namespace and provides the environment to its specs under a
key of its own. A namespace still unusable after a minute rejects with an
error naming it, the server's last answer as its `cause`.
[Test a Temporal worker](/how-to/test-a-temporal-worker#workers-a-global-setup-shares-a-namespace-per-run)
has the setup.

The fixture reads the address through Vitest's `inject`, under the key the
setup provides. A run that gets its server elsewhere — a long-lived one a CI
job provides — passes that address as `TEMPORAL_ADDRESS` to `boot` directly,
or provides the same key from a setup of its own.

## Peer dependencies

`@temporalio/client` and `@temporalio/common` (the namespace registration),
`testcontainers` (`^12.0.0`) and `vitest` (`>=3.2.0`, the first release with
file-scoped fixtures). Both are imported when the setup or the fixture runs,
not when the entry loads, so a spec worker never loads `testcontainers` and the
setup's process never loads Vitest's runner. Node `>=22.22`; the package
exports ESM only, as its `vitest` peer does.
