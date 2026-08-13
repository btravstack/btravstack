---
title: Wiring defects
description: "The pre-construction checks — cycle, duplicate provider, set/ordinary conflict, provider for Scope, missing provider — their exact messages, and the channel they arrive on."
---

# Wiring defects

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
  ok: (ctx) => /* ... */,
  errCases: (m) => /* modeled construction failures — never wiring bugs */,
  defect: (cause) => {
    // a WiringDefect: cycle, duplicate, missing provider, ...
    console.error(cause);
    return /* ... */;
  },
});
```

In tests, [`@unthrown/vitest`](https://github.com/btravstack/unthrown)'s
`toBeDefect()` asserts on it directly.
([Why this split](/explanation/failures-vs-defects).)

## The checks

Run in this order, at every entry point, on the flattened provider tree.

### A provider for `Scope`

```
[di] Scope cannot be provided; open one with Module.scoped instead
```

`Scope` is a phantom requirement, not a service. The type-only export already
makes this hard to write; the runtime check (keyed on the port **id**, so no
type-level widening escapes it) is defence in depth.

### One port, two kinds

```
[di] port "X" is registered as both a set port and an ordinary port
```

The same `portId` reached by `Provider(...)` in one place and
`Provider.member(...)` in another. Left unchecked, whichever landed second
would silently win, and the eventual failure would say nothing about the
cause.

### Two providers for one port

```
[di] two providers registered for port "X"
```

An **ordinary** port with two distinct providers anywhere in the tree — two
modules each providing the same port, both imported. One of them would
silently shadow the other, so it is a defect instead. The same provider
reached twice through a diamond is fine — de-duplication is by reference.
Set ports are exempt: accumulating members is
[their whole point](/how-to/plugin-registry).

### A dependency nothing provides

```
[di] no provider for port "X", required by "Y"
```

A `deps` entry no provider in the tree supplies — and, for a
[fork](/reference/entry-points#module-forkscope-parent-module-use-options),
the parent context does not carry either. The compile-time `Needs` gate
catches this first in ordinary code; the runtime check is what stands when a
type was widened past it.

### A dependency cycle

```
[di] dependency cycle among ports: X, Y, Z
```

The listed ports' providers each wait on another; no construction order
exists. The list is every provider that could not be scheduled — the cycle's
members and anything downstream of them.

## What is _not_ a defect

- **A failing `make`/`acquire`** — a modeled failure, on the error channel
  `E`, matched in `errCases`.
- **An unmet need visible in the types** — refused at compile time by the
  ["UNSATISFIED DEPENDENCIES" gate](/reference/entry-points#the-gate); the
  runtime missing-provider check is its backstop, not its replacement.
- **A duplicate port id** (two port classes sharing an id) — a declaration
  bug the build cannot see (the two are one key to it), warned once per id in
  development: `[di] duplicate port id "X" — one will shadow the other`.
