---
title: Modules and privacy
description: The built container is one flat map at runtime — module privacy is the type system withholding names, and why that is both enough and the point.
---

# Modules and privacy

> **Explanation.** This page explains what enforces a module's `exports`
> boundary, and why the honest answer — nothing, at runtime — is the design
> rather than a gap. For the task, see
> [Keep a port private](/how-to/keep-a-port-private); for the surface,
> [Modules](/reference/di/modules).

A module's `exports` list promises that its internals — the pool behind the
repository, the parsed config behind the client — cannot be reached from
outside. This page is about what enforces that promise, because the honest
answer is surprising: at runtime, nothing does.

## The flat map

Build any module tree and the result is a single map from port id to service.
`Persistence`'s private `Pool` is in it, right next to the exported
`OrderRepository` — there is nowhere else to put it; the repository's own
construction had to read it. No nested containers, no per-module resolution
scopes, no hierarchy to walk at `get` time.

Runtime enforcement would mean wrapping that map per module boundary —
tracking, for every caller, which module's vantage point it holds. That is a
real design (nested injectors exist in other containers), and it buys real
costs: resolution walks a chain, module boundaries exist as objects with
lifetimes of their own, and the failure mode is a **runtime** "not visible
from here" — precisely the class of surprise this container exists to remove.

## Privacy is a missing name

`di` enforces the boundary one level earlier. The built `Context<X>` is typed
by the module's `Exports` channel, and `ctx.get` only accepts ports in `X`:

```ts
ctx.get(OrderRepository); // exported — compiles
ctx.get(Pool); // does not compile — Pool is not in X
```

The `Pool` service is present in the map; the **type that would let you ask
for it** is not in scope. The same withholding governs wiring: a provider in
`App` cannot list `Pool` in its `deps`, because what `App` can see — its own
provides, its imports' exports — does not include it, and the dependency would
surface as [`UNSATISFIED DEPENDENCIES`](/explanation/compile-time-wiring) at
the entry point. Privacy and dependency-checking are one mechanism, not two.

This is privacy in exactly the sense TypeScript itself uses everywhere else:
`#private` fields aside, an unexported type, a module-private symbol, an
`internal` API are all names withheld rather than bytes hidden. `di` extends
the convention to wiring.

## What it does not defend against

A determined caller can cast — `ctx as any`, a hand-rolled object with the
right `portId` — and reach anything in the map. The boundary is not a security
perimeter, and does not try to be: the threat model is **accident**, not
adversary. What it prevents is the quiet coupling where application code
starts importing an adapter's internals because they happened to be
reachable, and a year later the adapter cannot change without breaking its
callers.

Because the guarantee lives entirely in the types, its regression tests do
too: [Hexagonal order API](/examples/hexagonal-order-api) pins "`ctx.get(Pool)`
does not compile" with a `@ts-expect-error` in a `.test-d.ts` file. A runtime
test could only prove the opposite — the flat map genuinely holds the pool —
which is true, and not the point.

## What the flat map buys in exchange

- **`get` is a map lookup.** No chain to walk, no vantage-point bookkeeping,
  no allocation per boundary.
- **One instance per provider, ever.** A diamond — two modules importing the
  same `Config` — cannot yield two configs, because de-duplication happens on
  provider identity before construction and the result lands in one map.
  Nested-container designs have to work to get this right; here it falls out.
- **Whole-module re-export is free.** `exports: [DatabaseModule]` forwards a
  type; nothing is copied or proxied at runtime.
- **The type-level model stays honest.** `Available` (what a module can see)
  and `Exports` (what it shows) are set computations over port types —
  checkable, testable, and identical in shape to what the runtime actually
  does with ids in a map.
- **The kernel needs no back door.** `start` wraps your module in one more
  that imports it, provides `Env` and re-exports it whole — so `X` stays
  exactly what you composed, and `Env` reaches every provider, and every
  per-unit fork, through the ordinary graph rather than a side channel.

The trade, stated once: `di`'s module boundary is exactly as strong as the
type system's reach, in exchange for a runtime with nothing in it to
misbehave. Where the types end — casts, duplicate ids, widening —
[pre-construction defect checks](/reference/di/wiring-defects) stand behind
them; what those catch is wiring bugs, not privacy violations, because past
the types a privacy violation is indistinguishable from intent.
