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

- **`Logger`, `LoggerService`, `Level`, `LEVELS`, `Attributes`,
  `Tracer`, `Meter` and the types behind them are `@btravstack/core`'s.** They
  are documented in `packages/core/CLAUDE.md`, imported from there by
  everything here, and **not re-exported** — one home per contract, so two
  import paths can never drift. The paragraphs below describe what this
  package does with them.
- **The logger's shape**, for the reader who is here rather than there —
  `LoggerService` is
  `log(level, message, attributes?, cause?)`, one method per level with the
  **same three arguments in the same order** — `(message, attributes?,
cause?)` — plus `with(attributes)` and `isEnabled(level)`. The uniformity
  was a correction: `error(message, cause, attributes)` read better at the one
  call site that always has a cause, made every other site remember which arm
  it was in, and left `warn` with nowhere to put one — so a retryable failure
  (a broker refusing a publish, which the next sweep takes) had to be logged
  at `error` purely to keep its reason, and `kernelEvents`' `teardownError`
  arm silently dropped the finaliser's error. A failure is not a property of
  severity. The cost is `logger.error("boom", undefined, cause)` for a failure
  with nothing else to say; a line worth writing almost always has an id to
  write with it. It is the framework's port, not
  the application's: the framework itself logs (see `kernelEvents`), so an
  application-declared port could not serve both, and every application
  declaring the same port by hand was the copy-paste the `Env` port removed for
  configuration.
- **Six differences from NestJS's `Logger`**, each a defect this shape does not
  have, and the reason the port looks the way it does: a port rather than a
  class you `new` (no static, no `useLogger` reaching past DI); `with` returns
  a value rather than `setContext` mutating the instance every caller shares;
  `Attributes` is a flat record of scalars rather than `any` varargs; a failure
  has its own `cause` channel; it cannot throw; and correlation is the
  implementation's job, not the caller's. Keep that list in the port's TSDoc —
  it is the package's whole argument.
- **`createLogger(sink, level?)`** — the implementation. Two load-bearing
  details: `currentUnit()` is read **per call** (one logger per scope, a
  record per unit — capturing it at construction would stamp the first unit's
  trace id on every line thereafter), and every write is wrapped in a `try` that
  swallows, because a logger that throws turns an observability fault into an
  outage. `with` layers attributes and shares the sink, so a child costs one
  object.
- **`Line` / `Sink`** — what an implementation hands a destination:
  `{ level, message, attributes, cause, time, unit }`, where `unit` is
  `undefined` outside a unit and `{ unitId, traceId, tenantId? }` inside one.
  A `Sink` is `(line: Line) => void` and is allowed to throw — `createLogger`
  is what makes that safe.
- **`jsonSink(stream?)`** (`json-sink.ts`) — the default: one JSON object per
  line on `process.stdout`. The caller's attributes are spread **first** and
  the line's own fields after them, which is what makes the precedence true:
  a caller's `{ level: "info" }` can never rewrite an `error` line's severity,
  nor its `traceId`. The unit's ids are spread at the **top level**, not
  nested under `unit`: `traceId` is the field an operator searches. and `renderCause` walks `Error.cause` up to four levels because an
  `Error`'s `message` and `stack` are non-enumerable and a bare
  `JSON.stringify` renders the line that exists to carry a failure as `{}` —
  the same rule, and the same reason, as the kernel's `stderrSink`. A payload
  `JSON.stringify` refuses outright falls back to the message and its severity
  rather than costing the line.
- **`observability({ sink?, level? })`** (`observability.ts`) — the starter:
  a `Module<Logger | LoggerConfig, ConfigInvalid, Env>` providing the logger
  and the configuration it was built from. `level` **pins** the way every
  starter's options pin (explicit > env > default, through `Config.pinned`).
- **`LoggerConfig`** — `{ level }`, bound through `Config.provider` from
  `LOG_LEVEL` (default `info`). A value outside the six is a `ConfigInvalid`
  naming the variable and the set — exit `78` under `runMain`, before a line is
  written — rather than a silent fallback: a deployment that meant `debug` and
  typed `verbose` should be told, not quietly under-logged for a week.
- **`logLevel({ default? })`** (`config.ts`) — that field on its own, exported
  so an application composing its own schema can reuse the validation rather
  than re-deriving it.
- **`kernelEvents(logger)`** — the kernel's `EventSink` over the logger, for
  `StartOptions.onEvent`. The mapping is deliberate, not mechanical:
  `startFailed` and `uncaught` are `error` (they carry a cause and are what an
  operator is paged for), `teardownError` is `warn` (the application is already
  stopping and the exit code says so), everything else is `info`. Each event's
  own fields become **attributes** — `draining` keeps `inFlight`, `drained`
  keeps the three report numbers — so a drain is queryable by field rather than
  parsed out of a sentence. `serving` is the one that needs a guard: its `info`
  is `unknown` (the kernel cannot know a runtime's `Info` at the event union),
  so it is **spread only when it is a plain record** — which is what puts
  `port`, `taskQueue`/`namespace` and `queues` on the line for free, with no
  per-runtime logging code, and what keeps a hand-rolled runtime publishing a
  string from costing the line. `probePort` rides beside it as its own field. The logger is a **parameter**, not resolved from
  the graph: `building` is emitted while the graph is still being built, so the
  sink cannot come from the context it is watching. That is also why an
  application wiring this passes `createLogger(jsonSink())` by hand in
  `main.ts` — a second logger, deliberately, and the only one the framework
  asks anybody to construct.
- **`pinoSink(logger)`** (`pino.ts`, the `@btravstack/observability/pino`
  subpath) — a `Sink` over a pino logger, for a deployment where the default
  sink's `JSON.stringify` per line shows up in a profile. `pino` is an
  **optional** peer: a consumer that never imports the subpath never installs
  it. The level filter stays **ours** — `createLogger` has already decided the
  line is worth writing by the time a sink sees it — so pino is configured at
  `trace` in the docs and the spec, one filter in the process, and it is the
  one `LOG_LEVEL` validated. The cause is handed over as `err`, which pino's
  own serialiser renders with the stack.

## Specs

`vitest run --coverage`, 100% lines/functions like every other package, 26
tests across four files:

- `logger.spec.ts` (8) — the surface (one line per level, at its own severity),
  the level floor and `isEnabled`, the cause channel, `with` layering **and not
  mutating** (the defect a mutable `setContext` has, asserted rather than
  asserted about), a call's attribute winning over a child's, a throwing sink
  swallowed, no `unit` outside a unit, the ambient record inside one, and the
  tenant a runtime supplied.
- `json-sink.spec.ts` (5) — the line shape and the trailing newline, an
  `Error`'s `message`/`stack`/`cause` chain surviving, a caller's attribute not
  rewriting `level`/`message`/`traceId`, a circular payload falling back to
  `[unserialisable]`, and the default stream being `process.stdout` (captured
  with a spy — read `mock.calls` **before** `mockRestore`, which clears them).
- `observability.spec.ts` (8) — the level bound from the environment and
  filtering the graph's own logger, `ConfigInvalid` for a level outside the
  six, a pinned level beating the environment, and the five `kernelEvents`
  mappings.
- `pino.spec.ts` (3) — fields pino can index, the `err` serialiser, and every
  level mapping onto pino's own numeric severity (`10`…`60`), so no level of
  ours silently collapses into another.

`test-fixtures.ts` carries a `Recorder` (the sink a spec asserts on), a
`Written` stream, `loggerAt(level)`, a `unitLogging` module for
`StartOptions.unit` — the only code that genuinely runs **inside** the kernel's
ambient record, since a test body does not — and a `tenantApp` whose
hand-rolled runtime opens a unit with a `tenantId`, which no shipped runtime
sets.

## Dependencies

Peers: `@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`,
with `pino`, `@opentelemetry/api` and `@opentelemetry/sdk-node` as
**optional** ones behind their subpaths. `@btravstack/core` is not optional
and cannot be: the ports this package implements are declared there. The package itself has no runtime
dependencies — the default sink is `JSON.stringify` and a `write`, for the same
reason `Config` is a hand-rolled Standard Schema.

## Deferred, deliberately

- **Traces and metrics shipped in issue #64**, as the deferred design
  prescribed, behind the `@btravstack/observability/otel` subpath on the
  `pino` protocol: `@opentelemetry/api` and `@opentelemetry/sdk-node` are
  **optional** peers a consumer that never imports the subpath never installs
  (`src/otel.ts` is `tsdown`'s third entry point). The surface: `otel(options?)`,
  a module providing the kernel's `Tracer` and `Meter` ports over a
  `NodeSDK` held as a **resourceful** provider — `release` is `sdk.shutdown()`,
  which flushes, so the kernel's close-on-every-path is what gets spans out of
  a dying process and a lost flush becomes a `teardownError` and exit `2`
  rather than silence (pinned by `otel.spec.ts` with an hour-delayed batch
  processor: the span leaves only because release flushed it) — and
  `UnitSpanModule`, a `StartOptions.unit` module opening a span per kernel
  unit with the ambient record's `unitId`/`traceId`/`tenantId` as attributes,
  ended by `onStop` on every path out. **No config slice, deliberately**: the
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
- **The two ports moved to `@btravstack/core` after this shipped**, when the
  first application-service package (`@btravstack/cache`) needed to depend on
  the contracts without pulling OTel in. `Tracer` kept its narrowed
  `{ startSpan(name) }`; `Meter` stopped being OTel's own type and became a
  narrowing too (`createCounter` / `createHistogram`, verified structurally
  against the real meter). Nothing here changed but the import: this file
  provides them, and no longer declares them.
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

- **`observability()` contributes the LINE**, and only for a failure:
  `component.name failed`, with the operation's attributes, its details and the
  cause. A success writes nothing — that is what the metric is for, and a line
  per success broke an application spec asserting that neither its controller
  nor its interactor had written anything.
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

**The tracer is read once and the meter per operation**, which is not symmetry
worth restoring: `trace.getTracer` answers a proxy that resolves when the SDK
registers, and `metrics.getMeter` does not — read once before `sdk.start()` it
returns the no-op meter and keeps it. Only the instruments it mints are cached.

**Details ride the span and the line, never an instrument.** `Operation.details`
is the unbounded half — a cache key, a mail subject, a URL — and putting it on a
counter is one time series per value. The first cut of the shared observer did
exactly that with `btravstack.cache.key`.
