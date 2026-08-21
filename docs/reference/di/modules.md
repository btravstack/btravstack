---
title: Modules
description: "Module(name)({ imports, provides, exports }) — what each list means, how the Exports/E/Needs channels are computed, the variance rule that keeps them honest, and the AnyModule/Exportable bounds a shaped module is built from."
---

# Modules

> **Reference.** A complete, structured description of `Module`. For the
> reasoning behind the visibility boundary, see
> [Modules and privacy](/explanation/modules-and-privacy); for the entry
> points that build one, [Entry points](/reference/di/entry-points). Full
> signatures: [API reference](/api/di/).

A module groups providers and draws a visibility boundary. Like a provider, it
is a declaration — building happens only at an
[entry point](/reference/di/entry-points).

## `Module(name)(options)`

```ts
const Persistence = Module("Persistence")({
  imports: [Config],
  provides: [
    Provider(Pool)(
      { config: AppConfig },
      { acquire: openPool, release: (p) => p.close() },
    ),
    Provider(OrderRepository)({ pool: Pool }, { sync: makeRepository }),
  ],
  exports: [OrderRepository],
});
```

All three lists are optional and default to empty.

| List       | Contents                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imports`  | Modules whose **exports** become visible inside this one. A diamond — two imports that both import a third — is fine: providers are de-duplicated by reference at build time, so the shared module's services construct once.                                                                                                                               |
| `provides` | This module's own providers. A provider here may depend on anything **available** in this module: ports provided here, plus ports exported by the imports. Order within the list does not matter for correctness — dependency order is computed at build time — but it is what makes error selection deterministic when several fail at once.               |
| `exports`  | The ports outside code may see. Each entry must be an **available port** — provided here, or exported by an import — a **provider for one**, which is normalised to `provider.port`, or an **imported module**, a whole-module re-export forwarding that module's own `exports` (never its internals). Anything else is a compile error at the declaration. |

Exporting a provider means exactly what exporting its port class means — same
`Exports` channel, same gates — and it is the only spelling available when the
port was minted inside a helper (`Config.provider("RelayConfig")(schema)`,
`HttpController(name, fragment)`), where there is no class to name:

```ts
exports: [Logger, ordersController], // a port class and a provider, together
```

Everything provided but not exported is
[private to the module](/how-to/keep-a-port-private): present in the built
flat map at runtime, unnameable through the built `Context`'s type.

## The channels

`Module<Exports, E, Needs>`:

| Channel   | Computed as                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Exports` | The union of exported ports' instance types, whole-module re-exports contributing their own `Exports`. This becomes the `Context<X>` channel an entry point hands back.                                                                                                                                                                                                                                                                                                                                                                                       |
| `E`       | Every way construction can fail: the union of all providers' error channels, here and in every import, transitively.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Needs`   | Everything still unmet: the union of all providers' needs and all imports' needs, **minus** what is available here. A dependency satisfied by a sibling provider or an import's export disappears from `Needs`; one nothing supplies propagates upward until some module satisfies it — or is refused at the entry point by the [`UNSATISFIED DEPENDENCIES` gate](/reference/di/entry-points#the-gate). `Scope`, once introduced by a resourceful provider, propagates the same way and is discharged only by `Module.scoped`, `Module.forkScope` or `start`. |

The variance rule, shared with [`Provider`](/reference/di/providers#the-channels):

> Capability channels (`Exports`) are contravariant, so you may forget what
> you have. Obligation channels (`E`, `Needs`) are covariant, so you may not
> forget what you owe.

Concretely: annotating a module as exporting less than it does is fine
(forgetting a capability); annotating away an error case or an unmet need does
not compile (laundering an obligation). This is what makes the adapter-seam
pattern safe:

```ts
const makeAppModule = <E, N>(persistence: Module<OrderRepository, E, N>) =>
  Module("App")({
    imports: [persistence],
    provides: [getOrder],
    exports: [GetOrder],
  });
```

Any module exporting `OrderRepository` fits, and whatever it may fail with or
still need flows through `E`/`N` into the result — invisibly to the seam,
inescapably at the entry point. It is also what lets `start` accept
`Module<X, E, Scope | Env>`: a module needing nothing, one needing `Scope`, and
one needing `Env` are all assignable to it, and one needing anything else is
not.

## `AnyModule`, `AnyProvider` and `Exportable`

Three structural, channel-free bounds, exported for one purpose: a package
that offers a **shaped module** — the starters' `HttpModule(name)({ router,
imports, provides, exports })`, `TemporalModule`, `AmqpModule` — needs to
constrain its `imports`/`provides`/`exports` exactly the way `Module(name)`
does, augment them, and hand the tuples to `Module(name)({...})` itself, so
the sugar's return type is spelled once, by `di`.

| Type                                                                           | Shape                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AnyModule`                                                                    | `{ name: string; imports: readonly AnyModule[]; provides: readonly AnyProvider[]; exports: readonly (AnyPort \| AnyModule)[] }` — every module, whatever its channels.                                                                                                                                     |
| `AnyProvider`                                                                  | `{ port: AnyPort; deps: readonly AnyPort[] }` — every provider, whatever its channels. See [Providers](/reference/di/providers#anyprovider).                                                                                                                                                               |
| `Exportable<I extends readonly AnyModule[], P extends readonly AnyProvider[]>` | What one `exports` entry may be, given the module's `imports` `I` and `provides` `P`: an available port — one whose instance type is among `I`'s exports or `P`'s ports — a provider for such a port, or one of the modules in `I`. `Module(name)`'s own `exports` is typed `readonly Exportable<I, P>[]`. |

An application never writes these; a package composing a `Module` on an
application's behalf does.

## What a module is at runtime

A plain object: `{ name, imports, provides, exports }`. Declaring one runs no
factories, opens nothing, allocates nothing but the object itself — building a
module fresh per call (`makeAppModule(...)`, a per-request module for
[`forkScope`](/reference/di/entry-points#module-forkscope-parent-module-use-options))
is cheap and idiomatic. The channels are phantom: they exist only in the type,
which is why every wiring property they express is settled before runtime.
