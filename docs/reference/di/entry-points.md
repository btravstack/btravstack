---
title: Entry points
description: "Module.build, Module.scoped and Module.forkScope — signatures, the UNSATISFIED DEPENDENCIES marker, ScopedOptions and Context, precisely — and where btravstack takes over for a whole process."
---

<!-- doctest: prelude
import { Port, type Context } from "@btravstack/di";
class SomePort extends Port("SomePort")<{ readonly go: () => void }> {}
declare const ctx: Context<SomePort>;
-->

# Entry points

> **Reference.** A complete, structured description of the three functions
> that turn a module into running services, and of the `Context` they hand
> back. For the reasoning behind the gate, see
> [Compile errors, not surprises](/explanation/compile-time-wiring); behind the
> scope, [Scopes and resource safety](/explanation/scopes-and-resources). Full
> signatures: [API reference](/api/di/).

Three functions turn a module declaration into running services. They differ
in one thing: what they do about scopes — and therefore which graphs the type
system lets each accept. A **process** has a fourth:
[`start`](/reference/core/start), which is `Module.scoped` with a lifecycle
around it.

## The gate

Every entry point carries the same compile-time gate, as a marker intersected
onto its `module` parameter: when the module's remaining `Needs` (after the
exclusions each entry point is entitled to) is `never`, the marker is
`unknown` — invisible in an intersection — and the call is ordinary; when it
is not, the marker is an object with one required property and the argument
fails assignability. The fix is always to satisfy the need.

**What it prints, measured:**

```text
error TS2345: Argument of type 'Module<Repo, never, Cfg>' is not assignable to parameter of type 'Module<Repo, never, Cfg> & { readonly "UNSATISFIED DEPENDENCIES — nothing provides": Cfg; }'.
  Property '"UNSATISFIED DEPENDENCIES — nothing provides"' is missing in type 'Module<Repo, never, Cfg>' but required in type '{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Cfg; }'.
```

The message ends on the missing ports — `Cfg` here; a union when several are
unmet. This is the same mechanism as declaration-time
[`NeedsGate`](/reference/di/modules) and `@btravstack/core`'s
[`start`](/reference/core/start) gate, one shape everywhere a composing
application is refused.

| Entry point        | Excludes from `Needs` before checking |
| ------------------ | ------------------------------------- |
| `Module.build`     | nothing                               |
| `Module.scoped`    | `Scope`                               |
| `Module.forkScope` | `Scope` and the parent's channel      |
| `start`            | `Scope` and `Env`                     |

## `Module.build(module)`

<!-- doctest: skip — a usage sketch over schematic type variables (X, E, A), not a program -->

```ts
const built: AsyncResult<Context<X>, E> = Module.build(App);
```

Checks the graph, constructs every provider in dependency order, resolves to
the built [`Context`](#context). For modules with **no unmet needs at all**:
the gate excludes nothing, so `Scope` in `Needs` — any resourceful provider,
any `onStop` hook, anywhere in the tree — makes the call refuse to compile.
`build` opens no scope and runs no teardown; that is exactly why it may not
accept a graph that would need one.

The `Context` it resolves to has no scope behind it — appropriate for services
that live as long as the process.

## `Module.scoped(module, use, options?)`

<!-- doctest: skip — a usage sketch over schematic type variables (X, E, A), not a program -->

```ts
const result: AsyncResult<A, E | E2> = Module.scoped(
  App,
  (ctx) => useIt(ctx),
  options,
);
```

The resourceful counterpart. Opens a scope, builds the graph, hands the
`Context<X>` to `use`, and **closes the scope before its own result settles**
— on `use` succeeding, on `use` failing, and on construction failing partway
(releasing whatever was acquired before the failure).

- The gate is computed from `Exclude<Needs, Scope>`: `Scope` is the one need
  this entry point discharges, by actually opening a scope. Every other unmet
  need still gates.
- The error channel is `E | E2` — construction failures and `use`'s own
  failures share the result.
- A non-resourceful module is fine here too; a scope with nothing registered
  closes trivially.

The `Context` must not outlive the callback — after `use` settles, acquired
resources are released. Do what needs services **inside** `use`.

## `Module.forkScope(parent, module, use, options?)`

<!-- doctest: skip — a usage sketch over schematic type variables (X, E, A), not a program -->

```ts
const result: AsyncResult<A, E | E2> = Module.forkScope(
  appCtx,
  RequestModule,
  (ctx) => handle(ctx.get(Transaction)),
);
```

A short-lived scope layered over an **already-built** parent `Context` — the
per-request pattern. Constructs only `module`'s providers, seeded with the
parent's services; `use` receives a `Context<PParent | X>` carrying both.

- The gate is computed from `Exclude<Needs, PParent | Scope>`: the request
  module may depend on anything the parent already provides — that is the
  point of forking over a built parent — and `Scope` is discharged by the
  fresh scope this call opens. Anything neither satisfies still gates.
- Closing the fork releases **only what the fork acquired**: the parent's
  finalisers were registered on the parent's scope, not this one. The parent
  stays up for sibling forks and for whatever follows.
- Forks nest: a fork's `use` may fork again over the context it received.

Under the kernel you rarely call this yourself: `StartOptions.unit` names a
module the kernel forks around **every unit**, and the same gate is checked at
`start`'s call site as
`"UNSATISFIED UNIT NEEDS — the unit module needs a port the module does not export"`. See
[Open a per-request scope](/how-to/open-a-per-request-scope).

## `ScopedOptions`

Accepted by `Module.scoped` and `Module.forkScope`:

<!-- doctest: signature=@btravstack/di -->

```ts
type ScopedOptions = {
  readonly onTeardownError?: (portId: string, cause: unknown) => void;
};
```

Called once per finaliser (`release` or `onStop`) that fails during scope
close, tagged with the failing provider's port id. Failures are reported and
**swallowed**: teardown continues past them, and the entry point's own result
is never changed by one — a failed close must not mask the failure that
triggered the unwind. The default reporter writes to `console.error`. A
throwing reporter is itself swallowed; there is nowhere left to report a
broken reporter to.

## `Context`

What entry points hand back or pass to callbacks:

```ts
const service = ctx.get(SomePort); // typed exactly as the port declared
```

| Member            | Meaning                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.get(port)`   | Returns the constructed service. Only ports in the context's channel — the module's `Exports` (plus the parent's, in a fork) — compile; everything else is unnameable. On a [set port](/reference/di/ports#port-many-id-member), returns every accumulated contribution. |
| `Context.empty()` | A `Context<never>` with nothing in it. Useful as a typed starting point in tests.                                                                                                                                                                                        |
| `Context<in R>`   | The type. `R` is the union of port instance types it carries; it is contravariant, so a `Context<A \| B>` may be passed where a `Context<A>` is expected — never the reverse.                                                                                            |

A `Context` is immutable and read-only from the outside: `get` is its entire
public surface. Services construct once per build; every `get` returns the
same instance.

## `start(module, options?)` — the process entry point

`@btravstack/core`'s [`start`](/reference/core/start) accepts a
`Module<X, E, Scope | Env>`, provides `Env` to it, and hands it to
`Module.scoped` — so the application scope is opened as the process boots and
closed on every exit path, with what its finalisers report surfacing as
`ExitReport.teardownErrors`. It adds a gate of its own on top of di's
(`NO RUNTIME`, `UNSATISFIED RUNTIME PORTS`, `UNSATISFIED UNIT NEEDS`), and
`RunningApp` rather than a `Context` is what it hands back: the runtime, not
the caller, is what reads the built context.

## Construction order and failure

Shared by all three entry points:

1. The provider tree is flattened (de-duplicated by reference — a diamond
   constructs once) and [checked](/reference/di/wiring-defects); nothing has
   run yet if a check fails.
2. Providers are grouped into dependency levels. Each level constructs
   **concurrently**; levels run strictly in order.
3. On a failure, siblings already in flight settle, then the build stops —
   later levels never start. Within a level, the failure reported is the
   first `Err` in **declaration order**; a defect in the level outranks any
   `Err`. Under a scope, everything acquired so far is then released.
4. `onStart` hooks fire only after the whole graph is built, sequentially, in
   declaration order; one that throws or rejects is a defect and stops the
   rest.
