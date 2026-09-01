---
title: Modules
description: "Module(name)({ imports, provides, exports, needs }) — what each list means, how the Exports/E/Needs channels are computed, the declaration gate that refuses an unnamed need, and the AnyModule/Exportable bounds a shaped module is built from."
---

<!-- doctest: prelude
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { Env } from "@btravstack/config";
import type { AsyncResult } from "unthrown";
type PoolClient = { readonly close: () => void };
class Pool extends Port("Pool")<PoolClient> {}
class AppConfig extends Port("AppConfig")<{ readonly url: string }> {}
type Order = { readonly id: string };
class OrderRepository extends Port("OrderRepository")<{
  readonly find: (id: string) => AsyncResult<Order, never>;
}> {}
declare const Config: Module<AppConfig, never, Env>;
declare const openPool: (deps: {
  readonly config: ServiceOf<AppConfig>;
}) => AsyncResult<PoolClient, never>;
declare const makeRepository: (deps: {
  readonly pool: ServiceOf<Pool>;
}) => ServiceOf<OrderRepository>;
class Logger extends Port("Logger")<{
  readonly info: (message: string) => void;
}> {}
const auditHandler = Provider(
  Port("AuditHandler")<{ readonly handle: () => void }>,
)({
  inject: { logger: Logger },
  sync: ({ logger }) => ({ handle: () => logger.info("audited") }),
});
-->

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
  needs: [Env],
  imports: [Config],
  provides: [
    Provider(Pool)({
      inject: { config: AppConfig },
      acquire: openPool,
      release: (p) => p.close(),
    }),
    Provider(OrderRepository)({ inject: { pool: Pool }, sync: makeRepository }),
  ],
  exports: [OrderRepository],
});
```

All four lists are optional and default to empty.

| List       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imports`  | Modules whose **exports** become visible inside this one. A diamond — two imports that both import a third — is fine: providers are de-duplicated by reference at build time, so the shared module's services construct once.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `provides` | This module's own providers. A provider here may depend on anything **available** in this module: ports provided here, plus ports exported by the imports. Order within the list does not matter for correctness — dependency order is computed at build time — but it is what makes error selection deterministic when several fail at once.                                                                                                                                                                                                                                                                                                         |
| `needs`    | The ports **this module's own providers** expect a composition root to supply. A provider here may depend on a declared need and have it satisfied by whatever an ancestor supplies; what declaring does **not** do is provide the port locally, so it is not `Available` and cannot be exported. Nor does it manufacture an obligation — it is permission for a real one to travel outward. Anything this module's providers owe and it does not name here is a compile error **at this call** (below). An **import's** own needs travel without being restated — they are already in that import's type. `Scope` is exempt: nothing can provide it. |
| `exports`  | The ports outside code may see. Each entry must be an **available port** — provided here, or exported by an import — a **provider for one**, which is normalised to `provider.port`, or an **imported module**, a whole-module re-export forwarding that module's own `exports` (never its internals). Anything else is a compile error at the declaration.                                                                                                                                                                                                                                                                                           |

Exporting a provider means exactly what exporting its port class means — same
`Exports` channel, same gates — and it is the only spelling available when the
port was minted inside a helper (`Config.provider("RelayConfig")(schema)`,
`api.OrpcController(contract, path)`), where there is no class to name:

<!-- doctest: skip — an exports-line excerpt of the module shown in full below -->

```ts
exports: [Logger, ordersController], // a port class and a provider, together
```

Everything provided but not exported is
[private to the module](/how-to/keep-a-port-private): present in the built
flat map at runtime, unnameable through the built `Context`'s type.

## The channels

`Module<Exports, E, Needs>`:

| Channel   | Computed as                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Exports` | The union of exported ports' instance types, whole-module re-exports contributing their own `Exports`. This becomes the `Context<X>` channel an entry point hands back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `E`       | Every way construction can fail: the union of all providers' error channels, here and in every import, transitively.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Needs`   | Everything still unmet: the union of all providers' needs and all imports' needs, **minus** what is available here. A dependency satisfied by a sibling provider or an import's export disappears from `Needs`; one nothing supplies travels outward — declared by the module whose own providers read it, then inherited by importers without being restated — until some module satisfies it, or is refused at the entry point by the [`UNSATISFIED DEPENDENCIES` gate](/reference/di/entry-points#the-gate). `Scope`, once introduced by a resourceful provider, travels the same way without being declared, and is discharged only by `Module.scoped`, `Module.forkScope` or `start`. |

## The declaration gate

A module that depends on a port it neither provides nor imports must say so:

```ts
const Slice = Module("Slice")({
  needs: [Logger], // "some root supplies this"
  provides: [auditHandler],
  exports: [auditHandler],
});
```

Leave it out and the call does not compile, and the diagnostic names the port:

```
Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
  '{ provides: [...]; exports: [...]; }' but required in type
  '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
```

The gate reads **this module's own providers only**. A module that merely
imports `Slice` restates nothing — the obligation is in `Slice`'s type, and the
entry point is still what refuses a root that has not discharged it. So the
declaration lands on the feature that reads the port, once, rather than on every
module between it and the root.

This is why a slice directory can be read on its own: it names the ports that
come from outside without naming who supplies them, so the same slice still
composes into any root that answers them. See
[Modules and privacy](/explanation/modules-and-privacy) for why the rule is
this shape rather than NestJS's, and why there is no `@Global`.

The variance rule, shared with [`Provider`](/reference/di/providers#the-channels):

> Capability channels (`Exports`) are contravariant, so you may forget what
> you have. Obligation channels (`E`, `Needs`) are covariant, so you may not
> forget what you owe.

Concretely: annotating a module as exporting less than it does is fine
(forgetting a capability); annotating away an error case or an unmet need does
not compile (laundering an obligation). This is what makes the adapter-seam
pattern safe:

<!-- doctest: skip — names its type arguments schematically (Options, Imports, Provides); the shaped-module pattern's real spelling is `packages/http-server`'s HttpModule -->

```ts
const makeAppModule = <E, N extends Scope>(
  persistence: Module<OrderRepository, E, N>,
) =>
  Module("App")({
    imports: [persistence],
    provides: [getOrder],
    exports: [GetOrder],
  } as Options & NeedsGate<Imports, Provides, []>);
```

The bound and the assertion are both the declaration gate: `NeedsGate` cannot
be computed while `I` is still a type parameter, so a **generic** seam has to
assert past it — and it may only do so honestly, which is what constraining the
adapter to owe at most `Scope` says. A shaped module — a starter's
`HttpModule(name)({ … })` — does the same thing one level up: it re-declares
`NeedsGate` on its own options, so the gate still fires at the application's
call, and asserts past it internally.

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
