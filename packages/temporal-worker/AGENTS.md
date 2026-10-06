# packages/temporal-worker

The Temporal worker starter's decisions, gotchas and exclusions. Its surface —
every export, option and default — is `docs/reference/temporal-worker.md`, and
the root `CLAUDE.md` is the authoritative spec for the kernel and the
conventions; this file holds what only matters when you are working under
`packages/temporal-worker/`. Keep it in sync with the code in the same commit:
the doc-samples gate compiles the `ts` fences of `README.md` and the reference
page, never this file.

## Decisions and gotchas

- **`TemporalModule`'s return type is di's own `Module(name)({...})` over the
  augmented tuples, never a named alias.** A named generic alias was tried and
  removed: declaration emit keeps it unreduced and cannot name imported
  modules' internal ports (TS2883, measured on `HttpModule`).
  `test-fixtures.ts`'s `compose` is written with the sugar, so the suite
  exercises it.

  `TemporalModule` also takes **`needs`**, forwarded to di's own — what this
  root's OWN providers expect from outside. The starter's `Env` is not among them: the
  starter is an import, and an import's needs travel without being restated. A
  root that provides a config provider of its own does declare it —
  `examples/order-amqp-worker` says `needs: [Env]` for `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

- **The `context.unit` record is built by a wrapper on the piece, not by the
  middleware**, and that is the decision. `activityUnits` leaves the forked `Context` on the
  invocation's context under a symbol; each piece's `sync` return is wrapped
  once, as di constructs it, so an attempt costs one `unitRecordOf` and one
  context object. Two things fall out of it. A `key → record` map threaded from
  the composing call into `createWorker` could not reach a hand-composed
  `temporal({ contract })`, which takes its activities as a NEED and never sees
  the provider — the record travelling WITH the piece that declared it has no
  such hole. And the middleware sees Temporal's **flat** activity name
  (`invocation.activityName`) while a piece is keyed by the top-level record
  key, which would have made that map a name translation as well; wrapping the
  implementation itself makes the question moot, since the wrapper is already
  where the name resolves.

  **The wrapper reaches inside two entry shapes**, which is where Temporal
  differs from `@btravstack/amqp-worker`'s `handler | [handler, options]`: a
  workflow key's entry is a **record** of implementations and a
  contract-global key's entry is the implementation itself, so `withUnit`
  wraps a function directly and maps a record's values. Both are covered by
  the `scoped` fixture's pair of pieces, driven by one workflow.

- **`unit?: { activity?: Unit }`**, on `TemporalModule` and `temporal()` —
  the module that `activityUnits`, the worker's dispatch middleware, forks around every activity attempt, **seeded
  with the validated input on `ActivityInput(contract)`**.
  Built after the activity is invoked, before it runs; torn down when
  the unit closes. There is exactly ONE kind, `activity`: an attempt is an
  attempt, where `@btravstack/http-server` has a kind per authentication
  scheme, so no fallback question arises and an unbound `unit` simply forks
  nothing.

- **The kernel's per-unit `AbortSignal` reaches an activity through the
  ambient `currentUnit()` record, and only through it.**
  `examples/order-temporal-worker`'s `ShippingService.arrange` is the worked
  answer: it fails as a **defect** on an aborted signal, which the platform
  retries on another worker, where the contract's `ShippingUnavailable` is a
  permanent no.
- **Cross-cutting concerns: the question does not arise here.** There is no
  origin, no preflight and no browser, so CORS and security headers are
  meaningless on this transport, and the connection is already authenticated —
  by Temporal itself, at `TEMPORAL_ADDRESS` and its namespace, before a task is
  polled. Per-activity identity is a **field on the contract's own input**, the
  way `tenantId` already is on every workflow and activity input in
  `examples/order-temporal-worker`, and nothing this package reads. Limiting
  throughput is the Worker's own concurrency options, not a policy slot.
  `@btravstack/contract` is dependency-free, so its marker combinator _would_
  work over a Temporal contract; it is deliberately not wired, because there is
  nothing here to authenticate **from**.
- **`workflow-activities.test-d.ts` pins the composing form's compile-time
  gates**, on a `pinContract` of its own, mirroring
  `@btravstack/amqp-worker`'s `handler.test-d.ts` property for property: the
  two are deliberate mirrors, so a gate added to one belongs in the other.

- **`traceparent` is deliberately not read here** (issue #64, where http and
  amqp learned it). A workflow's inbound context does not arrive as wire
  headers this starter sees — Temporal's own interceptor ecosystem owns
  cross-workflow propagation — and the workflow/activity id already IS the
  correlation this transport means: minted outside the process, stable across
  every retry and replay, which is exactly what `UnitMeta.traceId` exists to
  carry. A deployment that wants full OTel propagation through Temporal wires
  Temporal's own OpenTelemetry interceptors beside `otel()`, not through this
  package.

## `ensureSchedule` — from `@btravstack/temporal-worker/schedule`

`ensureSchedule(schedules, workflowName, options)` →
`AsyncResult<"created" | "updated", WorkflowNotInContractError | WorkflowValidationError | ScheduleNotFoundError>`,
where `schedules` is `@temporal-contract/client`'s `TypedScheduleClient` —
reached as `typedClient.for(contract).schedule` — and `options` is its own
`TypedScheduleCreateOptions`. `@temporal-contract/client` is an **optional
peer** behind the subpath, the `@btravstack/observability/pino` protocol: a
consumer that never imports it installs nothing.

**It exists for idempotence and nothing else.** The typed client's `create`
already does the work; it answers `ScheduleAlreadyExistsError` for an id in
use, which is correct and is the wrong shape for the one place schedules get
registered — a deploy, which runs again on every release. The repair people
reach for is a `try`/ignore, and that hides the failure that matters: a
schedule left on the server with a spec the deploy stopped writing.

Two things it deliberately does not do:

- **It reconciles `spec`, the action's `workflowType` and `args`, and
  `policies` — not the rest.** `state` is preserved because a schedule an
  operator paused stays paused across a deploy: unpausing it is a decision a
  person made. `memo`, `searchAttributes` and the action's eight optional
  overrides are preserved because rebuilding the action wholesale means
  reproducing `create`'s own assembly here — the task queue read off the
  contract, the search-attribute translation, every override — a copy that
  drifts with the library; changing one of those is a delete-and-create.

  **The args used to be preserved too, on a rationale that was false.** It read
  "the handle's `update` validates nothing, so writing them would push
  unvalidated input at the server" — but `@temporal-contract/client`'s
  `wrapScheduleHandle.update` validates the returned action's `args` against
  the named workflow's schema before persisting anything, and its
  `WorkflowValidationError` was already in this function's error union. So the
  cost of the caution was the failure it was meant to prevent: a deploy that
  changed the workflow's arguments answered `"updated"` while the server kept
  firing the old action. `schedule.spec.ts` pins both halves — the args move,
  and args the schema refuses are refused on the UPDATE path, not only on
  create. `workflowType` is written beside them because it is what selects the
  schema they are checked against.

- **It recovers exactly one error.** The matcher has no wildcard, so the other
  two arms are named and re-erred, and a fourth error added upstream fails this
  file rather than being silently recovered into a schedule nobody registered.
  Both arms are covered by `schedule.spec.ts`, reached past the types.

Why a subpath rather than a `-client` package, against the naming thesis: that
rule exists because peers are per-package and a caller must not install the
serving half. This is not the calling half of a contract — it starts no
workflow and awaits no result — it is a deployment operation performed by
whoever ships the worker, who already holds this package.
