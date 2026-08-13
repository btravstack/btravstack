---
title: Compile errors, not surprises
description: How the Needs channel and a conditional rest parameter turn missing dependencies, leaked internals and forgotten scopes into errors at the call site — and where the compile-time line actually sits.
---

# Compile errors, not surprises

The package's one-sentence promise: **every wiring mistake it can catch is a
compile error, and everything it cannot is caught before any factory runs.**
This page is about the first half — the machinery, and the exact location of
the line between the halves.

## The ledger: `Needs`

Every provider declares what it reads (`deps`) and, by choosing a
construction arm, whether it owes teardown (`Scope`). Every module aggregates
those into a `Needs` channel and subtracts what is available inside it — its
own provides, its imports' exports. What survives the subtraction propagates
upward, module by module, exactly like an unpaid balance:

```
Provider(OrderRepository)([Pool], ...)        Needs: Pool
Persistence (provides Pool, exports OrderRepository)   Needs: Scope   ← Pool netted out; Pool's acquire owes Scope
App (imports Persistence)                     Needs: Scope   ← still unpaid
```

Nothing checks anything yet — declaration is free. The check happens at the
one place a graph becomes running services.

## The gate: an arity error

Each [entry point](/reference/entry-points) ends in a conditional rest
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
differs per entry point only in what it is entitled to exclude first:
`scoped` excludes `Scope` (it opens a real scope), `forkScope` excludes
`Scope` and the parent context's channel (the parent supplies those).

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
laundering fails. The opposite choice (contravariant, as function-parameter
position) would make that same assignment reduce to `never extends Database`,
trivially true, and an annotation as innocent as a helper's return type could
silently zero the ledger. The source pins this with type-level tests
(`*.test-d.ts`), because the guarantee lives entirely in the type system —
there is nothing to observe at runtime when it holds, only when it breaks.

## Where the line actually is

Honesty about the boundary matters more than the boast. Compile-time catches:

- a dependency nothing in scope provides;
- using a private (unexported) port from outside its module —
  [both naming its service and depending on it](/explanation/modules-and-privacy);
- exporting a port that is neither provided nor imported;
- a resourceful graph built without a scope, or an `onStop` hook that could
  never run;
- construction arms mixed in one provider, and dependency/parameter type
  mismatches.

Beyond the line — visible only once the graph is assembled as **values** — sit
a dependency cycle, two providers for one port declared in modules that never
see each other, one id used as both set and ordinary port, and a provider
smuggled in behind a widened type. Those are the
[wiring defects](/reference/wiring-defects): checked before any factory runs,
zero side effects performed, reported on the defect channel.

Two things bound the guarantee from below. Port identity is the **id string**,
so two port classes sharing an id are one key at runtime — a declaration bug
the types cannot see, warned about in development. And TypeScript offers
escape hatches (`as never`, `any`) that no library survives; the runtime
checks exist precisely so that even those degrade into a loud pre-construction
defect rather than silent misbehaviour.

## Why an arity error, of all things

The gate could have been a constraint (`N extends never`) on the module
parameter. The rest-parameter form was chosen because of what the _error_
looks like: the constraint form reports a failure on the whole argument,
deep in a generic instantiation; the arity form reports "expected 3
arguments, got 1" with a tuple whose labels spell `UNSATISFIED DEPENDENCIES`
and whose type names the missing ports — at the call site, in the order a
reader debugs. When a guarantee's only user interface is a compiler
diagnostic, the diagnostic is the design.
