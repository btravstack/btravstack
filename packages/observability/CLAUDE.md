# packages/observability

The observability package's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what
only matters when you are working under `packages/observability/`. Keep it in
sync with the code in the same commit, and with `README.md` — the package
ships no `docs-examples.test-d.ts`, so nothing else compiles these claims.

## What this is, and what it is not yet

Logging, today. The package is named for the whole of observability because
logs, traces and metrics share a correlation id, a resource, a config slice
and a flush-on-shutdown lifecycle — splitting them across two packages would
duplicate all four, and the second would end up depending on the first. Traces
and metrics are **not here yet**; the shape they will take is in
_Deferred, deliberately_ at the end of this file. Do not describe them as
shipped.

## Public surface

- **`Logger`** (`logger.ts`) — `Port("Logger")` over `LoggerService`:
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
- **`Level` / `LEVELS`** — `trace | debug | info | warn | error | fatal`,
  ordered, exported as an array so `logLevel` validates against one list and a
  future OTel bridge maps severities without a table of synonyms.
- **`Attributes`** — `Readonly<Record<string, string | number | boolean |
undefined>>`. Flat and scalar deliberately: a nested object is where a field
  name stops being stable across lines, and an `unknown` value is where a
  logger starts stringifying whatever it is handed — which is how a log call
  becomes the thing that throws.
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
  parsed out of a sentence. The logger is a **parameter**, not resolved from
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
and `pino` as an **optional** one. The package itself has no runtime
dependencies — the default sink is `JSON.stringify` and a `write`, for the same
reason `Config` is a hand-rolled Standard Schema.

## Deferred, deliberately

- **Traces and metrics.** The shape: `Tracer`/`Meter` ports, the OTel
  `NodeSDK` as a **resourceful** provider whose `release` flushes — the kernel
  closes the scope on every exit path, so a lost span becomes a
  `teardownError` and exit `2` rather than silence — a span per unit as a
  `StartOptions.unit` provider (the kernel already tears that down inside the
  unit's ambient record, so no kernel change is needed), an OTel appender as a
  `Sink`, and W3C `traceparent` propagation feeding `UnitMeta.traceId` in the
  three transport starters (`@btravstack/http` reads `x-request-id` today).
- **A constraint that will not go away**: OTel _auto_-instrumentation
  (`@opentelemetry/auto-instrumentations-node/register`) must be preloaded
  before the instrumented libraries are imported, so it cannot be DI-provided.
  The package will ship manual instrumentation for what this stack owns and
  document the `--import` preload for third-party libraries; do not try to
  wire auto-instrumentation into a provider.
