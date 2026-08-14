# packages/temporal

The Temporal worker runtime's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what only
matters when you are working under `packages/temporal/`. Keep it in sync
with the code in the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`temporalRuntime(options)` → `Runtime<Needs, TemporalInfo>`** — runs a
  `@temporalio/worker` Worker under the kernel's lifecycle.
  `TemporalOptions<Needs>` — `connection` (a `NativeConnection` the caller
  opened, and therefore closes), `taskQueue`, `namespace` (default
  `"default"`), `workflows` (a `WorkflowSource`: `{ workflowsPath }` or
  `{ workflowBundle }`), `activities`, `needs`, `forceAfter` (Temporal's
  `shutdownForceTime`, default `15 seconds`) and `gracePeriod`
  (`shutdownGraceTime`, default `10 seconds`). `TemporalInfo` is
  `{ taskQueue, namespace }`, published on `Serving.info` once polling.
- **`activities`** is a **builder** — `(host: RuntimeHost<Needs>) => Record<…>`
  — because the middleware needs the host and the host does not exist until
  `start` calls the runtime. The package never wraps what it returns, which is
  what makes double-wrapping impossible rather than something to detect. It is
  called **inside** the qualified chain (`fromThrowable`), not before it:
  `declareActivitiesHandler` throws on a contract it cannot satisfy, and that
  throw is a startup failure like any other — `Err(RuntimeStartFailed)`, exit
  `1`, not a `Defect` and exit `70`.
- **`activityUnits(host)` → `ActivityMiddleware<Needs>`** — the one line a
  `temporal-contract` user adds, in `declareActivitiesHandler`'s `middleware`
  slot. It opens one kernel unit per activity **attempt** (`id` is the base64
  task token, `traceId` the workflow id) and injects
  `ActivityUnitContext<Needs>` — `{ ctx }` — through `temporal-contract`'s own
  per-invocation channel, which is why the deferred per-unit `forkScope` will
  land without an API change. **Pass the type argument** (or hoist the call)
  when an implementation reads `context.ctx`: TypeScript infers the injected
  context from the middleware's type and infers nothing from a generic call it
  is still resolving.
- **`temporal-contract` is a devDependency, never a peer.**
  `ActivityMiddleware` is declared **structurally** in `activity-units.ts`, so a
  consumer who does not use `temporal-contract` never inherits it. That
  declaration carries the package's one cast and one `oxlint-disable`
  (`unthrown/no-ambiguous-error-type`): the chain's failure union is
  `temporal-contract`'s to name, and a middleware generic in that channel is one
  TypeScript infers nothing from.
- **The drain is the reason the package exists.** `Serving.drain` calls
  `worker.shutdown()` then waits on `run()` **raced against the kernel's
  deadline signal**, and keeps the signal so `stop()` is released by the same
  abort. `@temporalio/worker` exposes no public forced shutdown
  (`Worker.forceShutdown$` is `protected`, `Runtime.shutdown()` is
  process-global), so stopping the wait is the only escalation: the kernel is
  released on time, the work is reported `abandoned`, and the worker keeps
  winding down on Temporal's clock until the process exits.
- **Not included, deliberately**: `Result` → activity failure, which
  `declareActivitiesHandler` already owns. Doing it twice is what the removal of
  the raw-worker path was about.
- **`temporal-contract` needed no modification at all** to host this.
  `CreateWorkerOptions` is already `Omit<WorkerOptions, …>`, the handler's
  output is flat, middleware's `next({ context })` augments what flows
  downstream, and `createContext` runs once per activity execution. That last
  point is what makes the per-unit context ride through the library's own
  channel rather than a channel this package invented.
- Peer dependencies: `@btravstack/core`, `@btravstack/di`, `unthrown`,
  `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`.
