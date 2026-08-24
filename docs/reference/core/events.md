---
title: Kernel events
description: The nine KernelEvent variants with their fields, the EventSink type, and stderrSink's one-JSON-line format including how it renders an Error cause.
---

<!-- doctest: prelude
import { TestRuntimePort } from "@btravstack/testing";
import { Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
declare const OrderApi: Module<InstanceType<typeof TestRuntimePort>, never, Env | Scope>;
declare const RequestModule: Module<never, never, never>;
import { start, type EventSink } from "@btravstack/core";
-->

# Kernel events

> **Reference.** The nine events the kernel emits, the sink type that receives
> them, and the default sink's output format. For where the sink is set, see
> [start and StartOptions](/reference/core/start); for why the kernel emits
> events rather than logging, see [Design decisions](/explanation/design-decisions).

## `KernelEvent`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type KernelEvent =
  | { readonly type: "building" }
  | { readonly type: "startFailed"; readonly cause: unknown }
  | { readonly type: "serving"; readonly runtime: string }
  | { readonly type: "draining"; readonly inFlight: number }
  | { readonly type: "drained"; readonly report: DrainReport }
  | { readonly type: "stopping" }
  | { readonly type: "exited" }
  | {
      readonly type: "teardownError";
      readonly port: string;
      readonly cause: unknown;
    }
  | { readonly type: "uncaught"; readonly cause: unknown };
```

| Event           | Fields                           | Emitted when                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `building`      | —                                | `start` is called, before the probe server binds or the graph is built. Always the first event.                                                                                                                                                                                                    |
| `startFailed`   | `cause`                          | Anything failed before `serving`: a construction `Err` (a `ConfigInvalid` naming its variables), a runtime's `RuntimeStartFailed`, a probe bind failure, or a defect. `cause` is the `Err`'s error or the defect's cause. Emitted **before** `stopping`, so a process that never came up says why. |
| `serving`       | `runtime` — the runtime's `name` | The runtime answered `Ok(serving)`.                                                                                                                                                                                                                                                                |
| `draining`      | `inFlight`                       | A signal (or `requestDrain()`) arrived while serving. Emitted in the same synchronous turn readiness flips false, so `inFlight` equals the report's `inFlightAtStart`.                                                                                                                             |
| `drained`       | `report: DrainReport`            | The drain finished — by the registry going idle or by the deadline.                                                                                                                                                                                                                                |
| `stopping`      | —                                | The phase reached `stopping`: after the drain, or straight away for `stop()`, an uncaught exception or a startup failure.                                                                                                                                                                          |
| `exited`        | —                                | The phase reached `exited`. Always the last event.                                                                                                                                                                                                                                                 |
| `teardownError` | `port`, `cause`                  | A finaliser failed as a scope closed — the application scope's (also recorded in `ExitReport.teardownErrors`) or a `StartOptions.unit` module's (recorded nowhere else).                                                                                                                           |
| `uncaught`      | `cause`                          | An `uncaughtException` or `unhandledRejection` was caught by the kernel's handlers (`signals: true`). Only the **first** is reported; the shutdown it triggers may produce more noise, and the report names one cause.                                                                             |

`serving`, `stopping` and `exited` are emitted by the phase tracker as it
advances, so they can never be emitted twice or out of order.

## `EventSink`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type EventSink = (event: KernelEvent) => void;
```

Set through `StartOptions.onEvent`; default `stderrSink`. The kernel wraps
whatever it is given so that a **throwing sink is swallowed** — a broken
reporter must not take the process down mid-shutdown, and there is nowhere
left to report a broken reporter to. Two consequences: a sink that throws
loses that one event silently, and a sink that wants to fail loudly cannot.

## `stderrSink`

Writes **one JSON line per event** to `process.stderr`, `JSON.stringify` of
the event with two adjustments:

- An `Error` anywhere in the value — a `cause`, or a nested `cause` of one —
  is normalised to `{ name, message, stack, cause }`. `JSON.stringify` skips
  non-enumerable properties, and an `Error`'s `message` and `stack` are both
  non-enumerable, so a bare `Error` would render the two cause-carrying events
  as `{"cause":{}}` and the default crash report would name no error at all.
- A value `JSON.stringify` refuses outright (a circular object) does not cost
  the whole event: the line is written as `{"type":"<type>","cause":"[unserialisable]"}`
  instead. Left to throw, `safeSink` would swallow it and the event would be
  reported nowhere.

## A sample transcript

A signal-driven shutdown of an HTTP process with one request in flight, as
`stderrSink` writes it:

```json
{"type":"building"}
{"type":"serving","runtime":"http"}
{"type":"draining","inFlight":1}
{"type":"drained","report":{"inFlightAtStart":1,"completed":1,"abandoned":0}}
{"type":"stopping"}
{"type":"exited"}
```

The same process failing to configure — `PORT=abc` — never reaches `serving`
(the stack trace is elided here):

```json
{"type":"building"}
{"type":"startFailed","cause":{"name":"ConfigInvalid","message":"HttpConfig could not be configured:\n  PORT: is not a whole number: \"abc\"","stack":"Error\n    at …"}}
{"type":"stopping"}
{"type":"exited"}
```

The normalisation replaces the whole `Error` with the four-field object, so a
`TaggedError`'s own fields (`port`, `issues`) do **not** appear on the line;
its `message` — one line per variable — is what carries them. And a cause that
cannot be serialised at all:

```json
{ "type": "uncaught", "cause": "[unserialisable]" }
```

## Writing a sink

```ts
import { start, type EventSink } from "@btravstack/core";

const events: string[] = [];
const collect: EventSink = (event) => {
  events.push(event.type);
};

const app = start(OrderApi, { onEvent: collect, probes: false });
```

A sink is synchronous and returns `void`; anything it must await it schedules
itself. Under `@btravstack/testing`'s `bootFixture` the default sink is silent and a
call's own `onEvent` wins. Only `signals` is forced off; `probes` is merely
defaulted off, so a call may still ask for `{ probes: { port: 0 } }`.
