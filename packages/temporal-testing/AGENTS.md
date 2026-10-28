# packages/temporal-testing

The Temporal test server's decisions, gotchas and exclusions. Its surface is
`docs/reference/temporal-testing.md`, and the root `AGENTS.md` is the
authoritative spec for the kernel and the conventions; this file holds what only
matters when you are working under `packages/temporal-testing/`. Keep it in sync
with the code in the same commit.

## Decisions and gotchas

- **A package, not a subpath of the worker.** Peers are per-package, so a
  `/testing` subpath of `@btravstack/temporal-worker` would make
  `testcontainers` and `vitest` peers of a runtime package, ship test code in
  the worker's tarball, and make a `@btravstack/temporal-client` consumer
  install the worker to test its callers. It is named like the `-client` packages, for the half it serves.
  It peers on no `@btravstack/*` package, so neither starter's consumers pay
  for the other's peers. Registering a namespace takes `@temporalio/client`'s
  `Connection`, not the worker's `NativeConnection`, for the same reason.

- **The CLI's development server, not `temporalio/auto-setup` with
  PostgreSQL.** One container, in memory, healthy in seconds with no schema
  step, against three resources and a Ryuk reaper per run. It is a pinned
  image, so nothing is downloaded at test time. That rules out the
  time-skipping test server, whose binary download is why #553 declined it. The
  starters' own specs, namespaces, visibility listing and schedules included,
  pass against it, because `internal/test-infra` runs the same image and
  command. A namespace is usable as soon as it is registered. The fixture still
  waits for a namespace-scoped read, because a server provided some other way
  (a multi-service cluster) refreshes its registry per service.

- **Reuse is the default, because the cost was per process.** A consumer whose
  suites are separate Vitest processes paid a server per suite. `withReuse()`
  attaches later runs, and the container is not registered with Ryuk, so it
  outlives the run. That is the trade `internal/test-infra` already makes.
  `reuse: false` is for a setup that owns teardown.

- **Docker's name uniqueness is the cross-process lock.** `testcontainers`'
  reuse lock is per process, and its file lock is not exported, so concurrent
  first runs all miss the label lookup. The shared container is created under
  a fixed name, so one create wins and the others get a `409`. A `304` comes
  from starting a container the winner already started. The losers retry,
  find the winner by its reuse hash, and wait for it to be healthy. Docker
  reserves the name before it lists the container, and on a loaded host (a
  CI Docker-in-Docker that has just pulled the image) that gap outlasted a
  fixed ten attempts 100 ms apart, failing the loser with the `409`. So the
  retry runs until `startupTimeoutMs` from the setup's start, its pause
  doubling from 100 ms to 1 s. Only those two statuses are retried; any other
  failure is the run's at once, so a real failure is not multiplied by the
  budget.

  **The name is a digest of what the reuse hash covers that can vary** between
  installs: the image, `startupTimeoutMs` (the health check) and the installed
  `testcontainers` version (its labels). With a fixed name, a container left by
  an older `testcontainers` would hold the name while its hash no longer
  matched, and every run would be refused. **Each attempt builds a fresh
  `GenericContainer`**: `start()` writes the hash label into the instance's
  own create options, so starting the same instance twice hashes differently
  and never finds the winner.

  `TESTCONTAINERS_REUSE_ENABLE=false` turns `withReuse()` off inside
  `testcontainers`. A named container would then make every concurrent run
  after the first fail, so the setup owns its server instead.

- **One budget, `startupTimeoutMs`, drives every wait.** The Docker health
  check's start period and retry count, `testcontainers`' own startup
  timeout and the race retry above all take it, so none of them stays short on a loaded host. The
  default is `60_000`, `testcontainers`' own: the server is healthy in seconds,
  and the image pull is not part of the wait.

- **`vitest` and `testcontainers` are imported where they run.** The setup runs
  in Vitest's main process and the fixture in its workers. A static import
  would load `testcontainers` into every worker and Vitest's runner into the
  setup's process. `index.spec.ts` replaces `testcontainers` with
  `vi.doMock`, which only reaches a dynamic import.

- **A run's namespace is a function, not a setup that provides it.** Suites
  whose workers a `globalSetup` starts, shared across spec files, need one
  namespace for the run, registered where neither `inject` nor `vi` exists.
  `temporalNamespace(address, prefix)` is the registration
  `temporalEnvironment` itself uses, so there is one implementation, and it
  imports nothing from Vitest: its readiness retry is its own, a minute at
  250 ms, rejecting with an error that names the namespace. Each read runs
  under that minute's deadline, because a Temporal call without one can wait
  forever: `vi.waitFor` bounded a read that never answered, and a retry that
  only runs after a read fails would not. A setup that
  registered and provided one under a key of this package's would hand the
  specs a value the suite's own setup already holds, and that setup provides
  it anyway, beside the rest of what its workers were started with.

  It answers a `Promise`, not an `AsyncResult`, like `temporalServer` and
  the fixture: its callers are Vitest's `globalSetup` and fixture protocols,
  where a failure must reject to fail the run, and the package peers on no
  `unthrown`.

- **The namespace is the isolation, never the task queue**: the starter reads
  its queue off the contract, so two spec files booting one worker poll one
  queue, and suites listing workflows on a shared server would see each
  other's. Nothing is cleaned up: the run's end, or the container's, disposes.

## Tests

`index.spec.ts` covers the setup over a fake `testcontainers`, since starting a
second server in the gate is what root rule 7 forbids. It pins the image and
command, the shared name, the budget, the owned teardown, the race statuses
retried for the budget and the failures that are not. The race retry runs on
Vitest's fake clock, which is why it pauses with the global `setTimeout`:
`node:timers/promises` is not faked, so a pause through it would wait in real
time. The fixture runs against the server
`internal/test-infra` shares, which provides the same inject key. That
workspace cannot depend on this one, because this one devDepends on it, so it
restates the key's declaration. `src/__tests__/run-namespace.setup.ts` is a
second `globalSetup` that registers a namespace with `temporalNamespace`,
proving the registration outside any test, and a spec starts a workflow in it.
The namespace that never becomes usable is a faked `Connection.connect` on
the fake clock, since the real server makes every namespace usable at once.
