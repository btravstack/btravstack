---
title: Modules
description: "Module(name)({ imports, provides, exports }) — what each list means, how the Exports/E/Needs channels are computed, and the variance rule that keeps them honest."
---

# Modules

A module groups providers and draws a visibility boundary. Like a provider, it
is a declaration — building happens only at an
[entry point](/reference/entry-points).

## `Module(name)(options)`

```ts
const Persistence = Module("Persistence")({
  imports: [Config],
  provides: [
    Provider(Pool)([AppConfig], {
      acquire: openPool,
      release: (p) => p.close(),
    }),
    Provider(OrderRepository)([Pool], { sync: makeRepository }),
  ],
  exports: [OrderRepository],
});
```

All three lists are optional and default to empty.

### `imports`

Modules whose **exports** become visible inside this one. A diamond — two
imports that both import a third — is fine: providers are de-duplicated by
reference at build time, so the shared module's services construct once.

### `provides`

This module's own providers. What a provider here may depend on is anything
**available** in this module: ports provided here, plus ports exported by the
imports. Order within the list does not matter for correctness — dependency
order is computed at build time — but it is what makes error selection
deterministic when several providers fail at once.

### `exports`

The ports outside code may see. Each entry must be either:

- an **available port** — provided here, or exported by an import. Exporting
  anything else (a port from nowhere, an import's internal) is a compile
  error at the declaration; or
- an **imported module** — a whole-module re-export, forwarding that module's
  own `exports` (never its internals).

Everything provided but not exported is
[private to the module](/how-to/private-ports): present in the built flat map
at runtime, unnameable through the built `Context`'s type.

## The channels

`Module<Exports, E, Needs>`:

- **`Exports`** — the union of exported ports' instance types (whole-module
  re-exports contributing their own `Exports`). This becomes the `Context<X>`
  channel an entry point hands back.
- **`E`** — every way construction can fail: the union of all providers'
  error channels, here and in every import, transitively.
- **`Needs`** — everything still unmet: the union of all providers' needs and
  all imports' needs, **minus** what is available here. A dependency satisfied
  by a sibling provider or an import's export disappears from `Needs`; one
  nothing supplies propagates upward until some module satisfies it — or
  surfaces as the "UNSATISFIED DEPENDENCIES" compile error at the entry
  point. `Scope`, once introduced by a resourceful provider, propagates the
  same way and is discharged only by `Module.scoped` / `Module.forkScope`.

The variance rule, shared with [`Provider`](/reference/providers#the-channels):

> Capability channels (`Exports`) are contravariant, so you may forget what
> you have. Obligation channels (`E`, `Needs`) are covariant, so you may not
> forget what you owe.

Concretely: annotating a module as exporting less than it does is fine
(forgetting a capability); annotating away an error case or an unmet need
does not compile (laundering an obligation). This is what makes the
adapter-seam pattern safe:

```ts
const makeAppModule = <E, N>(persistence: Module<OrderRepository, E, N>) => /* ... */;
```

Any module exporting `OrderRepository` fits, and whatever it may fail with or
still need flows through `E`/`N` into the result — invisibly to the seam,
inescapably at the entry point.

## What a module is at runtime

A plain object: `{ name, imports, provides, exports }`. Declaring one runs no
factories, opens nothing, allocates nothing but the object itself — building a
module fresh per call (`makeAppModule(...)`, a per-request module for
[`forkScope`](/reference/entry-points#module-forkscope-parent-module-use-options))
is cheap and idiomatic. The channels are phantom: they exist only in the
type, which is why every wiring property they express is settled before
runtime.
