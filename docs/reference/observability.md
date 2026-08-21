---
title: "@btravstack/observability"
description: The complete surface of @btravstack/observability — the Logger port, createLogger, jsonSink, pinoSink, the observability starter, LOG_LEVEL and kernelEvents.
---

# @btravstack/observability

> **Reference.** A complete, structured description of
> `@btravstack/observability`: the `Logger` port and its service, the default
> implementation, the `Line`/`Sink` contract, the two sinks, the starter and
> the `LOG_LEVEL` field, and the kernel-event adapter. For the task, see
> [Log and correlate](/how-to/log-and-correlate); for the generated
> signatures, see the [API reference](/api/observability/).

Logging, today. The package is named for the whole of observability because
logs, traces and metrics share a correlation id, a resource, a configuration
slice and a flush-on-shutdown lifecycle — splitting them across two packages
would duplicate all four. **Traces and metrics are not here yet.**

## Install

```sh
pnpm add @btravstack/observability @btravstack/core @btravstack/config @btravstack/di unthrown
```

Those four are peers. `pino` is an **optional** peer, needed only if you
import the `@btravstack/observability/pino` subpath:

```sh
pnpm add pino
```

The package itself has no runtime dependencies: the default sink is
`JSON.stringify` and a `write`, for the same reason `Config` is a hand-rolled
Standard Schema.

## `Logger` and `LoggerService`

```ts
class Logger extends Port("Logger")<LoggerService> {}

type LoggerService = {
  readonly log: (
    level: Level,
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly trace: (
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly debug: (
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly info: (
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly warn: (
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly error: (
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly fatal: (
    message: string,
    attributes?: Attributes,
    cause?: unknown,
  ) => void;
  readonly with: (attributes: Attributes) => LoggerService;
  readonly isEnabled: (level: Level) => boolean;
};
```

`Logger` is a di port like any other: a provider binds it, a dependency array
names it, a test provides its own. It is the **framework's** port rather than
each application's, because the framework itself logs — `kernelEvents` below —
and an application-declared port could not serve both.

**Every method takes the same three arguments in the same order**, and every
level can carry a failure. The first draft did not: `error(message, cause,
attributes)` read better at the one call site that always has a cause, and it
cost twice — a caller had to remember which arm it was in, and `warn` had
nowhere to put a cause, so a retryable failure (a broker refusing a publish,
which the next sweep takes) was logged at `error` purely to keep its reason.
A failure is not a property of severity. The cost of uniformity is
`logger.error("boom", undefined, cause)` for a failure with nothing else to
say, which is rare: a line worth writing almost always has an id to write with
it.

Every method returns `void` and none of them is an `AsyncResult`. A log call
is fire-and-forget by definition — a caller who awaited it would be waiting on
I/O to decide nothing — and this is the package's exemption from the rule that
[every async surface returns a `Result`](/explanation/nothing-throws).

### Why the interface is strict

Each row is a defect this shape does not have, and together they are the
package's whole argument:

| Decision                                    | What it rules out                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A **port**, never a class you `new`         | A static instance, a `useLogger` reaching past DI, a global a test cannot replace                           |
| `with(attributes)` returns a **new** logger | `setContext` mutating the instance every caller shares, so two scopes interleave each other's context       |
| `Attributes` is a flat record of scalars    | `any` varargs, printf, and a logger that stringifies whatever it is handed — which is how a log call throws |
| A failure goes in **`cause`**               | `JSON.stringify(error)` rendering `{}`: an `Error`'s `message` and `stack` are non-enumerable               |
| It **cannot throw**                         | An observability fault becoming an outage; `createLogger` swallows a broken sink                            |
| Six levels, fixed                           | `LOG_LEVEL` validated against a set at startup, and `isEnabled` a comparison rather than a lookup           |
| Correlation is the implementation's job     | A trace id threaded through every signature to reach the one place that writes it out                       |

## `Level`, `LEVELS` and `Attributes`

```ts
type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
const LEVELS: readonly Level[];

type Attributes = Readonly<
  Record<string, string | number | boolean | undefined>
>;
```

`LEVELS` is the six in order, least severe first — what `isEnabled` compares
through, what `logLevel` validates against, and what a future OpenTelemetry
bridge maps to severity numbers without a table of synonyms. There is no
`silly`, no `verbose` and no caller-defined addition.

`Attributes` is flat and scalar deliberately. A nested object is where a
field's name stops being stable across lines (`user.id` on one, `user: { id }`
on another), and an `unknown` value is where a logger starts stringifying
whatever it is handed. Anything else is the caller's to render; a failure has
a channel of its own.

## `createLogger(sink, level?)`

```ts
createLogger(sink: Sink, level: Level = "info"): LoggerService;
```

The implementation. Two details are load-bearing:

- **`currentUnit()` is read per call**, not captured at construction. One
  logger is built per scope and every unit the kernel opens has its own
  record, so a captured one would stamp the first unit's trace id on every
  line thereafter. This is what makes a single application-scope logger
  correct for every request.
- **Every write is wrapped.** A sink that throws is swallowed here — there is
  nowhere left to report a broken reporter to, and a logger that takes the
  process down is worse than a line nobody sees.

`with(attributes)` layers attributes on top of this logger's and shares the
sink, so a child costs one object. A **call's** attribute wins over the
layered one; nothing mutates.

A line below `level` is dropped before the sink is called and before
`currentUnit()` is read.

## `Line` and `Sink`

```ts
type Line = {
  readonly level: Level;
  readonly message: string;
  readonly attributes: Attributes;
  readonly cause: unknown;
  readonly time: number; // milliseconds since the epoch, stamped at the write
  readonly unit:
    | {
        readonly unitId: string;
        readonly traceId: string;
        readonly tenantId?: string;
      }
    | undefined;
};

type Sink = (line: Line) => void;
```

`unit` is what [`currentUnit()`](/how-to/read-the-ambient-unit) carried, or
`undefined` outside a unit — a startup line, a package's own specs. `tenantId`
is present only when the runtime supplied one; no shipped starter does.
`deadline` and `signal` are on the ambient record but not on the line: they
are for code that must act on them, not for a log backend.

A `Sink` is allowed to throw. `createLogger` is what makes that safe, which is
why a sink is a plain function with no error channel of its own.

## `jsonSink(stream?)`

```ts
jsonSink(stream?: { readonly write: (chunk: string) => unknown }): Sink;
```

The default: one JSON object per line, `process.stdout` unless a stream is
given. The shape every log backend already reads, and the same one the
kernel's `stderrSink` writes its events in.

```json
{
  "orderId": "0199a1e0-0000-7000-8000-000000000001",
  "quantity": 2,
  "time": "2026-08-16T09:41:02.113Z",
  "level": "info",
  "message": "placing an order",
  "unitId": "3f9c…",
  "traceId": "b41e…"
}
```

Three rules:

- **The unit's ids are spread at the top level**, not nested under `unit`. A
  log backend indexes fields, and `traceId` is the field an operator searches.
- **A caller's attribute can never overwrite one of them**, nor `level`,
  `message` or `time`. An `attributes: { level: "info" }` that could rewrite
  the severity is how a log stream stops being trustworthy.
- **`cause` is normalised**, not stringified: an `Error` becomes
  `{ name, message, stack, cause }` and the `cause` chain is walked up to four
  levels. `JSON.stringify` skips non-enumerable properties, so a bare `Error`
  would render the line that exists to carry a failure as `{}` — the same rule,
  and the same reason, as the kernel's `stderrSink`.

A payload `JSON.stringify` refuses outright — a circular value reaching in
through `cause` is the plausible one — falls back to the time, level, message
and `cause: "[unserialisable]"` rather than costing the line.

## `observability(options?)`

```ts
observability(options?: ObservabilityOptions):
  Module<Logger | LoggerConfig, ConfigInvalid, Env>;

type ObservabilityOptions = {
  readonly sink?: Sink; // default: jsonSink()
  readonly level?: Level; // pins LOG_LEVEL
};
```

The starter: a module providing the application's `Logger` and the
`LoggerConfig` it was built from, both exported. Import it next to the
application and export `Logger` if anything outside the root reads it —
`StartOptions.unit`'s module, a test:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
  exports: [Logger],
});
```

It needs `Env`, which `start` provides to every graph it boots; outside the
kernel, provide it yourself with `Provider(Env)({ value: {} })`. Its error
channel is `ConfigInvalid`, which is how a bad `LOG_LEVEL` reaches
[exit code `78`](/reference/core/exit-codes).

`level` **pins** the way every starter's options pin — `Config.pinned`,
precedence explicit > environment > default, per field. `sink` replaces the
destination and nothing else; the level filter stays this package's.

An application that wants its own implementation entirely does not import
this module and provides `Logger` itself. Nothing else in the graph can tell.

## `LoggerConfig` and `LOG_LEVEL`

```ts
class LoggerConfig extends Port("LoggerConfig")<LoggerSettings> {}
type LoggerSettings = { readonly level: Level };
```

One variable today, bound through `Config.provider` like any other slice:

| Variable    | Field                            | Default | Invalid                                                                |
| ----------- | -------------------------------- | ------- | ---------------------------------------------------------------------- |
| `LOG_LEVEL` | one of the six levels, no others | `info`  | `must be one of trace, debug, info, warn, error, fatal, got "verbose"` |

A value outside the six is a `ConfigInvalid` naming the variable and the set —
reported as a `startFailed` event and **exit `78`** under `runMain`, before a
line is written — rather than a silent fallback: a deployment that meant
`debug` and typed `verbose` should be told, not quietly under-logged for a
week.

It is built on `Config.string`, so it inherits the semantics every other
variable has: an **unset** variable takes the default, a **set-but-blank** one
is an error. See [`@btravstack/config`](/reference/config).

### `logLevel(options?)`

```ts
logLevel(options?: { readonly default?: Level }): ConfigField<Level>;
```

That field on its own, exported so an application composing its own schema
reuses the validation rather than re-deriving it:

```ts
const appConfig = Config.provider("AppConfig")(
  Config.object({
    level: logLevel({ default: "debug" }),
    region: Config.string("REGION"),
  }),
);
```

## `kernelEvents(logger)`

```ts
kernelEvents(logger: LoggerService): EventSink;
```

The kernel's [nine lifecycle events](/reference/core/events) as log lines on
`logger`, for `StartOptions.onEvent`. The kernel's own default writes JSON to
stderr, which is right for a process with no logger and wrong for one with:
two streams, two shapes, two sets of fields to search.

The mapping is deliberate rather than mechanical. Each event's own fields
become **attributes**, so a drain is queryable by field rather than parsed out
of a sentence:

| Event           | Level   | Message                                                 | Attributes besides `event`                  | Carries `cause` |
| --------------- | ------- | ------------------------------------------------------- | ------------------------------------------- | --------------- |
| `building`      | `info`  | `building`                                              | —                                           | —               |
| `startFailed`   | `error` | `the application failed to start`                       | —                                           | yes             |
| `serving`       | `info`  | `serving`                                               | `runtime`                                   | —               |
| `draining`      | `info`  | `draining`                                              | `inFlight`                                  | —               |
| `drained`       | `info`  | `drained`                                               | `inFlightAtStart`, `completed`, `abandoned` | —               |
| `stopping`      | `info`  | `stopping`                                              | —                                           | —               |
| `exited`        | `info`  | `exited`                                                | —                                           | —               |
| `teardownError` | `warn`  | `a finaliser failed while the application was stopping` | `port`                                      | yes             |
| `uncaught`      | `error` | `an uncaught exception stopped the application`         | —                                           | yes             |

Every line carries `event` — the event's own `type` — as an attribute, so one
query finds the transitions whatever the message says. `startFailed` and
`uncaught` are errors because they carry a cause and are what an operator is
paged for; `teardownError` is a warning because the application is already
stopping and [the exit code](/reference/core/exit-codes) already says `2`.

::: warning The logger is a parameter, not a resolved port
`building` is emitted **while the graph is still being built**, and
`startFailed` when it never finished — so a sink taken out of the context it
is watching would have nothing to write the two events that matter most with.
That is why an application wiring this constructs a logger by hand in
`main.ts`, a second one deliberately, and the only one the framework asks
anybody to construct.
:::

```ts
await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

That logger reads no `LOG_LEVEL` — the binding lives in the graph it is
watching — so it logs at the default `info`.

## `pinoSink(logger)`

```ts
import { pinoSink } from "@btravstack/observability/pino";

pinoSink(logger: import("pino").Logger): Sink;
```

A `Sink` over a pino logger, behind a subpath so `pino` can be an **optional**
peer: a consumer that never imports it never installs it.

```ts
import pino from "pino";
import { observability } from "@btravstack/observability";
import { pinoSink } from "@btravstack/observability/pino";

observability({ sink: pinoSink(pino({ level: "trace" })) });
```

Configure pino at `trace`. **The level filter stays this package's**:
`createLogger` has already decided the line is worth writing by the time a
sink sees it, so one filter is in the process, and it is the one `LOG_LEVEL`
validated at startup. Two filters that can disagree is the failure this
avoids.

The attributes and the unit's ids ride as pino **fields**, not as a message
prefix, so they stay indexable; the cause is handed over as `err`, which
pino's own serialiser renders with the stack. Each of the six levels maps onto
pino's own method of the same name — `10` through `60` — so no level of ours
collapses into another.

## Summary of exports

| Export                 | Kind                                              |
| ---------------------- | ------------------------------------------------- |
| `Logger`               | port                                              |
| `LoggerService`        | type — the service behind it                      |
| `LoggerConfig`         | port — `{ level }`, bound from `LOG_LEVEL`        |
| `LoggerSettings`       | type                                              |
| `Level` / `LEVELS`     | type / value — the six, in order                  |
| `Attributes`           | type                                              |
| `Line` / `Sink`        | type — what an implementation hands a destination |
| `createLogger`         | value — the implementation                        |
| `jsonSink`             | value — the default sink                          |
| `observability`        | value — the starter                               |
| `ObservabilityOptions` | type                                              |
| `logLevel`             | value — the `LOG_LEVEL` field alone               |
| `kernelEvents`         | value — the kernel's `EventSink` over a logger    |
| `pinoSink`             | value — `@btravstack/observability/pino` only     |

## What it does not do

- **No traces and no metrics yet.** The shape they will take — `Tracer` /
  `Meter` ports, the OpenTelemetry `NodeSDK` as a resourceful provider whose
  `release` flushes, a span per unit through `StartOptions.unit`, W3C
  `traceparent` feeding `UnitMeta.traceId` — is recorded in the package's own
  spec. Nothing of it ships.
- **No transport, no rotation, no batching.** A sink is a function; a
  deployment that wants any of those brings pino, or writes eleven lines of
  its own.
- **No `Result` on a log call.** Delivery is the implementation's problem, and
  a lost line is not a modeled error.

## See also

- [Log and correlate](/how-to/log-and-correlate) — the task, end to end.
- [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit) —
  the record the logger reads, and who else may read it.
- [Kernel events](/reference/core/events) — the nine `kernelEvents` maps.
- [Configure from the environment](/how-to/configure-from-the-environment) —
  how `LOG_LEVEL` is bound, and what a bad one costs.
