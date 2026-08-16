---
title: Compile errors, not surprises
description: How the Needs channel and a conditional rest parameter turn missing dependencies, leaked internals, forgotten scopes and a missing runtime into errors at the call site — and where the compile-time line actually sits.
---

# Compile errors, not surprises

> **Explanation.** This page explains the machinery behind `di`'s one-sentence
> promise and the kernel's extension of it. For the surfaces it describes, see
> [Entry points](/reference/di/entry-points) and
> [`start`](/reference/core/start); for the half beyond the line,
> [Wiring defects](/reference/di/wiring-defects).

`di`'s promise: **every wiring mistake it can catch is a compile error, and
everything it cannot is caught before any factory runs.** This page is about
the first half — the machinery, and the exact location of the line between the
halves — and about the second gate `start` builds on top of it.

## The question the design answers

Dependency injection in TypeScript usually arrives as machinery: decorators,
reflection metadata, string tokens, a container you query at runtime and hope.
`di` starts from a different question — _what would it take for wiring
mistakes to be compile errors?_ — and lets the answer shape everything else.
The oldest idea here is hexagonal architecture's: an application defines
**ports** for what it needs, named by the domain (`OrderRepository`, `Clock`,
`Mailer`), and adapters implement them at the edge in a place the application
cannot see. `di` makes that structural rather than aspirational: a port is
nominal, so a `Cache` never satisfies a `SessionStore` by coincidence of
shape; `ServiceOf<P>` types a use case against the port so it never imports an
adapter; and a module's `exports` decides what the outside may even
[name](/explanation/modules-and-privacy).

Most of the rest of the design is refusals, each buying a guarantee. No
decorators, reflection or metadata — wiring is plain values and plain types,
so it survives every bundler unchanged and the compiler can actually check it.
No mutable container — there is no `container.register(...)` to call in test
setup and forget in teardown; swapping an adapter is
[composing a different module](/how-to/swap-an-adapter). No throwing — a
construction failure is a `Result` you match on, a wiring bug a defect on its
own channel. And no scope you can forget, which is where the ledger below
comes in.

## The ledger: `Needs`

Every provider declares what it reads (`deps`) and, by choosing a construction
arm, whether it owes teardown (`Scope`). Every module aggregates those into a
`Needs` channel and subtracts what is available inside it — its own provides,
its imports' exports. What survives the subtraction propagates upward, module
by module, exactly like an unpaid balance:

```
Provider(OrderRepository)([Pool], ...)                Needs: Pool
Persistence (provides Pool, exports OrderRepository)  Needs: Scope   ← Pool netted out; Pool's acquire owes Scope
App (imports Persistence)                             Needs: Scope   ← still unpaid
```

Nothing checks anything yet — declaration is free. The check happens at the
one place a graph becomes running services.

## The gate: an arity error

Each [entry point](/reference/di/entry-points) ends in a conditional rest
parameter:

```ts
build<X, E, N>(
  module: Module<X, E, N>,
  ..._missing: [N] extends [never] ? [] : [error: "UNSATISFIED DEPENDENCIES", missing: N]
)
```

When `Needs` is `never`, the tuple is empty and `Module.build(mod)` is an
ordinary call. When it is not, the call is missing two required arguments —
arguments no value can supply — and the error names both the literal
`"UNSATISFIED DEPENDENCIES"` and, in `missing`, the actual ports. The gate
differs per entry point only in what it is entitled to exclude first: `scoped`
excludes `Scope` (it opens a real scope), `forkScope` excludes `Scope` and the
parent context's channel (the parent supplies those).

The same trick guards a related mistake at declaration time: an `exports`
entry must be provided or imported, so a module cannot claim a surface it
does not have.

## Why the ledger cannot be cooked

A gate is only as good as the numbers reaching it. The reason nothing between
declaration and build can drop an entry is variance — the package's one rule:

> Capability channels are contravariant, so you may forget what you have.
> Obligation channels are covariant, so you may not forget what you owe.

`Needs` and `E` sit in covariant (return) position. Assigning
`Module<X, E, Database>` where `Module<X, E, never>` is expected asks the
compiler whether `Database` is assignable to `never` — it is not, and the
laundering fails. The opposite choice would make the same assignment reduce to
`never extends Database`, trivially true, and an annotation as innocent as a
helper's return type could silently zero the ledger. The source pins this with
type-level tests (`*.test-d.ts`), because the guarantee lives entirely in the
type system — there is nothing to observe at runtime when it holds, only when
it breaks.

## The kernel's own gate

`start` accepts a `Module<X, E, Scope | Env>` — covariance is what lets a
module needing nothing, one owing `Scope` and one reading `Env` all fit — and
then asks three questions of `X` that di's gate has no reason to ask. They
arrive as the same shape, a phantom rest tuple named `StartGate<X, UnitNeeds>`
that `start`, `runMain` and `@btravstack/testing`'s `withApp` and `Boot` all carry:

| Arm                         | Fires when                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO RUNTIME`                | The module exports no port declared over `RuntimePort`. A process boots exactly one runtime, and it is a service of the module — a root that forgets `HttpModule`/`http(...)` fails on arity here.                                                               |
| `UNSATISFIED RUNTIME NEEDS` | The runtime's declared `needs` are not among the module's exports — the **module's alone**, never the unit module's, because `RuntimeHost.ctx` is the application context and a unit-only port does not exist at startup. No shipped starter declares any today. |
| `UNSATISFIED UNIT NEEDS`    | With `StartOptions.unit`, the unit module's needs are not covered by the module's exports, `Scope` or `Env` — `forkScope`'s gate, stated at `start`'s call site, where the parent is actually known.                                                             |

```ts
const Application = Module("Application")({
  provides: [Provider(Greeter)({ value: { hello: () => "hi" } })],
  exports: [Greeter],
});

start(Application); // NO RUNTIME: the module exports no port declared over RuntimePort
```

The gate is a trailing rest tuple rather than a conditional type on `module`
or `options` for a reason di shares: a conditional on an inference-bearing
parameter makes TypeScript defer that parameter's inference and can collapse
`X` or `E` to `unknown`. And like di's, it is **bypassable on purpose** — a
caller who spells the phantom arguments out by hand does typecheck, which the
kernel's own type tests assert rather than assume. It takes a deliberate act;
the gate exists to catch the accident, not to be unforgeable.

## Where the line actually is

Honesty about the boundary matters more than the boast. Compile-time catches:

- a dependency nothing in scope provides;
- using a private (unexported) port from outside its module —
  [both naming its service and depending on it](/explanation/modules-and-privacy);
- exporting a port that is neither provided nor imported;
- a resourceful graph built without a scope, or an `onStop` hook that could
  never run;
- construction arms mixed in one provider, and dependency/parameter type
  mismatches;
- a composition with no runtime, or a unit module the application cannot
  satisfy.

Beyond the line — visible only once the graph is assembled as **values** — sit
a dependency cycle, two providers for one port declared in modules that never
see each other, one id used as both set and ordinary port, and a provider
smuggled in behind a widened type. Those are the
[wiring defects](/reference/di/wiring-defects): checked before any factory
runs, zero side effects performed, reported on the defect channel.

Two things bound the guarantee from below. Port identity is the **id string**,
so two port classes sharing an id are one key at runtime — a declaration bug
the types cannot see, warned about in development. And TypeScript offers
escape hatches (`as never`, `any`) that no library survives; the runtime checks
exist precisely so that even those degrade into a loud pre-construction defect
rather than silent misbehaviour.

## Why an arity error, of all things

The gate could have been a constraint (`N extends never`) on the module
parameter. The rest-parameter form was chosen because of what the _error_
looks like: the constraint form reports a failure on the whole argument, deep
in a generic instantiation; the arity form reports "expected 3 arguments, got
1" with a tuple whose labels spell `UNSATISFIED DEPENDENCIES` — or
`NO RUNTIME` — and whose type names the missing ports, at the call site, in
the order a reader debugs. When a guarantee's only user interface is a
compiler diagnostic, the diagnostic is the design.

## The cost, stated plainly

The types work hard, and it shows at the edges: a wiring mistake surfaces as
an arity error rather than a friendly sentence, and hovering a large module
shows real channel unions. The container is also deliberately small — one
construction family, one module algebra, three entry points, one name per
concept. Conditional registration DSLs, interceptors and property injection
are not missing features; this is the wrong library for them on purpose.
