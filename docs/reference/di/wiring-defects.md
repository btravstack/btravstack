---
title: Wiring defects
description: "The pre-construction checks — a provider for Scope, one id as two kinds, duplicate provider, missing provider, dependency cycle — their exact messages, and the channel they arrive on."
---

<!-- doctest: prelude
import { Module, Port, Provider, type Context } from "@btravstack/di";
import { P } from "unthrown";
class Greeter extends Port("Greeter")<{ readonly greet: () => string }> {}
const App = Module("App")({
  provides: [Provider(Greeter)({ value: { greet: () => "hi" } })],
  exports: [Greeter],
});
declare const respond: (ctx: Context<Greeter>) => number;
-->

# Wiring defects

> **Reference.** A complete list of the checks `di` runs before any factory,
> with the message each produces. For why a wiring bug is a defect and not a
> modeled failure, see [Nothing throws](/explanation/nothing-throws) and
> [Compile errors, not surprises](/explanation/compile-time-wiring).

Some wiring bugs cannot be expressed as type errors: a dependency cycle is
only visible once the whole graph is assembled; a duplicate provider may be
declared in two modules that never see each other's types. `di` catches every
one of these **before any factory runs** — a failing check has zero side
effects to unwind — and reports it as a **defect**, not a modeled failure.

## Where a defect arrives

A wiring defect is a bug in the program's wiring, not an outcome caller code
should branch on — so it does not join the entry point's error channel `E`.
It arrives on unthrown's **defect channel**, the same place a thrown exception
in your own code would land:

```ts
const outcome = await Module.build(App).match({
  ok: (ctx) => respond(ctx),
  errCases: (m) => m.with(P.tag("ConfigError"), () => 78), // modeled failures — never wiring bugs
  defect: (cause) => {
    console.error(cause); // a WiringDefect: cycle, duplicate, missing provider, …
    return 70;
  },
});
```

In tests, [`@unthrown/vitest`](https://github.com/btravstack/unthrown)'s
`toBeDefect()` asserts on it directly. Under `start`, the same defect reaches
`RunningApp.exited` as a defect, is reported by the `startFailed` event, and
`runMain` exits `70`.

## The checks

Run in this order, at every entry point, on the flattened provider tree.

| Check                         | Message                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| A provider for `Scope`        | `[di] Scope cannot be provided; open one with Module.scoped instead`  |
| One port, two kinds           | `[di] port "X" is registered as both a set port and an ordinary port` |
| Two providers for one port    | `[di] two providers registered for port "X"`                          |
| A dependency nothing provides | `[di] no provider for port "X", required by "Y"`                      |
| A dependency cycle            | `[di] dependency cycle among ports: X, Y, Z`                          |

### A provider for `Scope`

`Scope` is a phantom requirement, not a service. The type-only export already
makes this hard to write; the runtime check — keyed on the port **id**, so no
type-level widening escapes it — is defence in depth.

### One port, two kinds

The same `portId` reached by `Provider(...)` in one place and
`Provider.member(...)` in another. Left unchecked, whichever landed second
would silently win, and the eventual failure would say nothing about the
cause.

### Two providers for one port

An **ordinary** port with two distinct providers anywhere in the tree — two
modules each providing the same port, both imported. One of them would
silently shadow the other, so it is a defect instead. The same provider
reached twice through a diamond is fine — de-duplication is by reference. Set
ports are exempt: accumulating members is
[their whole point](/how-to/build-a-plugin-registry).

`start` leans on this check: it wraps your module with one providing `Env`
unless the module already provides `Env` itself — precisely so an application
that supplies its own environment does not trip it.

### A dependency nothing provides

A `deps` entry no provider in the tree supplies — and, for a
[fork](/reference/di/entry-points#module-forkscope-parent-module-use-options),
the parent context does not carry either. The compile-time `Needs` gate
catches this first in ordinary code; the runtime check is what stands when a
type was widened past it.

### A dependency cycle

The listed ports' providers each wait on another; no construction order
exists. The list is every provider that could not be scheduled — the cycle's
members and anything downstream of them.

## What is _not_ a defect

| Event                                                | Channel                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `make`/`acquire` returns `Err(...)`                | A modeled failure, on the error channel `E`, matched in `errCases`.                                                                                                                                                                                           |
| An unmet need visible in the types                   | Refused at compile time by the [`UNSATISFIED DEPENDENCIES` gate](/reference/di/entry-points#the-gate); the runtime missing-provider check is its backstop, not its replacement.                                                                               |
| A `release`/`onStop` fails during close              | Neither channel — reported through [`onTeardownError`](/reference/di/entry-points#scopedoptions) and swallowed, so teardown finishes and the failure that triggered the unwind is never masked. Under `start`, `ExitReport.teardownErrors` and exit code `2`. |
| A duplicate port id (two port classes sharing an id) | A declaration bug the build cannot see (the two are one key to it), warned once per id in development: `[di] duplicate port id "X" — one will shadow the other`.                                                                                              |

Two things **are** defects without being wiring checks: a factory that
**throws** despite promising a `Result`, and an `onStart` hook that throws or
rejects. Both are broken contracts, and both land on the same defect channel.
