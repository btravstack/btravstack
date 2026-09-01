---
title: Observability contracts
description: The Logger, Tracer, Meter and Observers ports the kernel declares — the contracts every framework package may depend on, and which @btravstack/observability implements.
---

# Observability contracts

> **Reference.** The three ports `@btravstack/core` declares and never
> implements: `Logger`, `Tracer` and `Meter`. What satisfies them lives in
> [`@btravstack/observability`](/reference/observability); what depends on
> them is any package at all, because the kernel is the one every package
> already peers on.

## Why they are here

A contract that framework packages depend on has to be reachable **without
installing an implementation**. `@btravstack/cache` counts its hits and logs
its failures; it must be able to say so in a type without every consumer
installing a logging package and an OpenTelemetry SDK to compile.

They also sit on a concept the kernel already owns. The correlation an
implementation stamps on every line — `unitId`, `traceId`, `tenantId` — is
`UnitRecord`'s, read through `currentUnit()`, which is the kernel's API.

The kernel neither provides nor consumes them. Its own output goes through
[`EventSink`](/reference/core/events), and `kernelEvents` in the
observability package is the adapter between the two.

## `Logger`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the kernel itself -->

```ts
class Logger extends Port("Logger")<LoggerService> {}

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
const LEVELS: readonly Level[];
type Attributes = Readonly<
  Record<string, string | number | boolean | undefined>
>;

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

Six methods, one argument order — `(message, attributes?, cause?)` — because a
failure is not a property of severity: an `info` line reporting a recovered
fault carries a cause too. Synchronous `void` rather than an `AsyncResult` is
[the everything-returns-an-AsyncResult rule](/explanation/nothing-throws)'s one deliberate exemption: a log call is
fire-and-forget, and a caller who awaited it would be waiting on I/O to decide
nothing.

The full argument for the shape — and the six differences from NestJS's
`Logger` that motivate each part of it — is on
[the implementation's page](/reference/observability).

## `Tracer` and `Meter`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the kernel itself -->

```ts
const SPAN_STATUS = { unset: 0, ok: 1, error: 2 } as const;
type SpanStatusCode = 0 | 1 | 2;

type Span = {
  readonly setAttributes: (attributes: Attributes) => unknown;
  readonly setStatus: (status: {
    readonly code: SpanStatusCode;
    readonly message?: string;
  }) => unknown;
  readonly end: () => void;
};

type TracerService = { readonly startSpan: (name: string) => Span };
class Tracer extends Port("Tracer")<TracerService> {}

type Counter = {
  readonly add: (value: number, attributes?: Attributes) => void;
};
type Histogram = {
  readonly record: (value: number, attributes?: Attributes) => void;
};

type MeterService = {
  readonly createCounter: (
    name: string,
    options?: { readonly description?: string; readonly unit?: string },
  ) => Counter;
  readonly createHistogram: (
    name: string,
    options?: { readonly description?: string; readonly unit?: string },
  ) => Histogram;
};
class Meter extends Port("Meter")<MeterService> {}
```

**Declared without naming OpenTelemetry**, and that is the point rather than
an omission. A port typed as a vendor's type points the dependency arrow
outwards — the mistake this stack documents everywhere else — and it would put
`@opentelemetry/api` in the install list of every package that merely _states_
a dependency on tracing.

They are **narrowings** of the ecosystem's own shapes, not a parallel
vocabulary: the status codes are OTel's numbers, and a real OTel `Span`,
`Tracer` and `Meter` satisfy these contracts structurally with no translation
in between — `metrics.getMeter()` _is_ a `MeterService`. So
[`otel()`](/reference/observability) is an ordinary adapter, and a different
backend is a different provider rather than a fork.

`MeterService` mints two instruments. A gauge or an up-down counter is
something an application declares about its own domain, and it reaches the
vendor's meter for that the way it reaches any other adapter; a framework
package counts what happened and measures how long it took.

## Who implements them

| Port              | Implementation                                                                  |
| ----------------- | ------------------------------------------------------------------------------- |
| `Logger`          | `observability()` — see [`@btravstack/observability`](/reference/observability) |
| `Tracer`, `Meter` | `otel()`, behind the `@btravstack/observability/otel` subpath                   |

An application that wants its own provides the port itself and composes
neither starter. Nothing in the kernel changes either way.

## See also

- [`@btravstack/observability`](/reference/observability) — the implementations.
- [Kernel events](/reference/core/events) — what the kernel writes through, which is not this.
- [Log and correlate](/how-to/log-and-correlate) — the task, end to end.

## `Observers` — how a starter reports, without holding a logger

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Operation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly details?: Attributes;
  readonly traced?: boolean;
};
type Settled = {
  readonly outcome: "ok" | "error";
  readonly attributes?: Attributes;
  readonly cause?: unknown;
};
type Settle = (settled: Settled) => void;
class Observers extends Port.many("Observers")<(operation: Operation) => Settle> {}

const observe: (
  observers: readonly ((operation: Operation) => Settle)[],
  operation: Operation,
) => Settle;
const noObserver: () => Settle;
```

Every starter that reports what it did — the three servers,
[`cache`](/reference/cache), [`mailer`](/reference/mailer),
[`storage`](/reference/storage), [`prisma`](/reference/prisma) — hands its
operations to this port and holds no `Logger`, `Meter` or `Tracer` of its own.
Composing [`observability()`](/reference/observability) writes the failures as
lines; composing `otel()` beside it opens the spans and mints the instruments.
A graph that composes neither owes nothing and pays one call per operation.

**A module that reads the port contributes `noObserver` itself.** A collector
depending on a set port nothing provides is an unmet dependency, so the no-op
member is what makes the empty case empty rather than missing.

**The observer is called at the START and answers a finisher**, which is what
lets it open a span before the work and end it after: a span reconstructed
afterwards from a duration is not the parent of anything that ran inside it.

**`attributes` are dimensions and `details` are not.** Attributes are bounded
and ride the instruments; details are unbounded — a cache key, a mail subject —
and ride the span and the error line only. That split is what lets one observer
serve every component without making each choose between a useful span and a
safe metric.

`traced: false` declines the span for a component whose spans come from
somewhere better — `@btravstack/prisma` says so, because
`@prisma/instrumentation` traces at the engine level and a client-level span
would carry strictly less beside it.
