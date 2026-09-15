# packages/observability

The observability package's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what
only matters when you are working under `packages/observability/`. Keep it in
sync with the code in the same commit, and with `README.md` — the package
ships no `docs-examples.test-d.ts`, so nothing else compiles these claims.

## What this is: the implementations, not the contracts

Logs, traces and metrics — all three ship. One package, because they share a
correlation id, a resource, a config slice and a flush-on-shutdown lifecycle;
splitting them would duplicate all four and the second half would depend on
the first.

**The ports are not here.** `Logger`, `Tracer` and `Meter`, and the service
types behind them, are declared in `@btravstack/core`; this package is where
they are _implemented_ — `createLogger` and the sinks for the first,
`otel()` for the other two. The split is the same one every port in this
stack makes, applied to the framework's own packages: a contract that other
framework packages depend on has to be reachable without installing an
implementation, and the kernel is the one package all of them already peer
on. It also let the tracing contracts stop naming OpenTelemetry — they are
narrowings of its shapes, so a real span, tracer and meter satisfy them
structurally and OTel's types stop at the `/otel` subpath.

So: to change what a logger _is_, edit `packages/core`. To change how one
_behaves_, edit here.

## Public surface

`Logger`, `Tracer`, `Meter` and their service types are `@btravstack/core`'s
(`packages/core/CLAUDE.md`) and are not re-exported. What this package exports
is `src/index.ts`, `src/pino.ts` and `src/otel.ts`, each with its TSDoc;
`docs/reference/observability.md` is the reader's page, including the logger's
argument order and the six differences from NestJS's `Logger`.

## Specs

What each spec file pins — the list, never a tally, since a count in prose is
stale the next time a case is added (#192):

- `logger.spec.ts` — the surface (one line per level, at its own severity),
  the level floor and `isEnabled`, the cause channel, `with` layering **and not
  mutating** (the defect a mutable `setContext` has, asserted rather than
  asserted about), a call's attribute winning over a child's, a throwing sink
  swallowed, no `unit` outside a unit, the ambient record inside one, and the
  tenant a runtime supplied.
- `json-sink.spec.ts` — the line shape and the trailing newline, an
  `Error`'s `message`/`stack`/`cause` chain surviving, a caller's attribute not
  rewriting `level`/`message`/`traceId`, a circular payload falling back to
  `[unserialisable]`, and the default stream being `process.stdout` (captured
  with a spy — read `mock.calls` **before** `mockRestore`, which clears them).
- `observability.spec.ts` — the level bound from the environment and
  filtering the graph's own logger, `ConfigInvalid` for a level outside the
  six, a pinned level beating the environment, and the five `kernelEvents`
  mappings.
- `observers.spec.ts` — what `observability()` contributes to `Observers`: a
  failed operation written as a line, a successful one written nowhere (that is
  what the metric is for), and the cause travelling with it.
- `otel.spec.ts` — the SDK half, behind the subpath: a span per unit flushed on
  the scope's close, an unattributed span outside a unit, OTel's own meter
  handed back ready to count, and an instrumentation a starter contributed
  being registered.
- `pino.spec.ts` — fields pino can index, the `err` serialiser, and every
  level mapping onto pino's own numeric severity (`10`…`60`), so no level of
  ours silently collapses into another.

`test-fixtures.ts` carries a `Recorder` (the sink a spec asserts on), a
`Written` stream, `loggerAt(level)`, a `unitLogging` module forked through
`testRuntime`'s own `unit` option — the only code that genuinely runs
**inside** the kernel's ambient record, since a test body does not — and a
`tenantApp` whose
hand-rolled runtime opens a unit with a `tenantId`, which no shipped runtime
sets.

## Deferred, deliberately

- **Traces and metrics ship behind the `@btravstack/observability/otel`
  subpath.** The surface: `otel(options?)`,
  a module providing the kernel's `Tracer` and `Meter` ports over a
  `NodeSDK` held as a **resourceful** provider — `release` is `sdk.shutdown()`,
  which flushes, so the kernel's close-on-every-path is what gets spans out of
  a dying process and a lost flush becomes a `teardownError` and exit `2`
  rather than silence (pinned by `otel.spec.ts` with an hour-delayed batch
  processor: the span leaves only because release flushed it) — and
  `UnitSpanModule`, a module a starter's own `unit` option binds — `unit: {
message: UnitSpanModule }`, `unit: { activity: UnitSpanModule }` — opening a
  span per unit the runtime forks it around, with the ambient record's
  `unitId`/`traceId`/`tenantId` as attributes, ended by `onStop` on every path
  out. **No config slice, deliberately**: the
  SDK reads the `OTEL_*` env conventions itself, and re-binding them through
  `Config` would be a second spelling of names operators already know. **One
  `otel()` per process**: the api's globals register once — the SDK's own
  contract, restated in the spec's teardown. The remote W3C **parent is
  deliberately not reconstructed**: `UnitMeta.traceId` carries the inbound
  trace id alone (never the caller's span id), so v1 correlates spans to logs
  by attribute rather than pretending to a parent-child edge it cannot prove.
  Inbound `traceparent` is honoured by `@btravstack/http-server` (over
  `x-request-id`) and `@btravstack/amqp-worker` (over `messageId`), trace-id field
  only; `@btravstack/temporal-worker` deliberately keeps the workflow/activity id as
  its correlation — see its own `CLAUDE.md`.
- **A constraint that will not go away**: OTel _auto_-instrumentation
  (`@opentelemetry/auto-instrumentations-node/register`) must be preloaded
  before the instrumented libraries are imported, so it cannot be DI-provided.
  The package ships the graph-owned half only and `otel`'s TSDoc says so;
  the `--import` preload is the deployment's line. Do not try to
  wire auto-instrumentation into a provider.

  **That rule is about the PRELOAD, not about instrumentations generally.** An
  instrumentation that patches nothing — one whose `enable()` sets a helper the
  instrumented library reads per call, as `@prisma/instrumentation` does — has
  no ordering requirement a provider cannot meet, and `otel()` registers those.
  A package contributes one to `@btravstack/core`'s `Instrumentations` set port;
  `otel()` loads every contribution and hands it to the `NodeSDK`. The test is
  whether the instrumentation patches module loading, not whether it is OTel.

## Collecting a starter's instrumentation

`otel()` depends on `Instrumentations` and registers what it finds, so
composing a starter DECLARES what can be instrumented and composing `otel()`
is what turns it on. A graph without an SDK collects nothing, loads nothing,
and installs nothing.

Each contribution is a bare loader, `() => Promise<unknown>` — nothing here
reads a name, and a loaded instrumentation already carries OTel's own
`instrumentationName`. It is async and answers `undefined`
rather than failing, because the package supplying the instrumentation is an
OPTIONAL peer that a consumer may not have installed — the contributor logs the
skip, since it is the one that knows why.

`otel()` contributes a member of its own that loads nothing. That is what makes
`Instrumentations` a port the graph always has: a collector depending on a set
port NOTHING provides is an unmet dependency both at plan time and in `Needs`.
Guice's `newSetBinder` declares the empty set for the same reason.

## The two `Observers` members this package contributes

`Observers` is declared in `@btravstack/core`; the members that do something
with an operation are here, and they are the reason a starter holds no `Logger`,
`Meter` or `Tracer` of its own.

- **`observability()` contributes the LINE**, and only for a failure — the root
  `CLAUDE.md`'s **Observability is a set port, never a flag** says why.
- **`otel()` contributes the SPAN and the INSTRUMENTS**:
  `component.name` as the span, `btravstack.<component>.operations` and
  `btravstack.<component>.duration` as the pair, both minted per component and
  cached. Names derived from the operation, so nothing had to become uniform to
  be shared.

**`otel()`'s member injects nothing, and that is load-bearing.** Depending on
`Tracer`/`Meter` is a dependency CYCLE — `OtelSdk` collects `Instrumentations`,
a starter's contribution may read `Observers`, and the member closes the loop
back onto the SDK. The examples' integration tests caught it as
`[di] dependency cycle among ports: OrderDatabase, HealthChecks, Instrumentations, …`.
