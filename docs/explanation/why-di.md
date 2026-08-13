---
title: Why di?
description: Ports as the application's own vocabulary, hexagonal architecture without decorators or reflection, and a container whose wiring mistakes are compile errors — the design, and what it refuses to do.
---

# Why di?

Dependency injection in TypeScript usually arrives as machinery: decorators,
reflection metadata, string tokens, a container you query at runtime and hope.
`di` starts from a different question — **what would it take for wiring
mistakes to be compile errors?** — and lets the answer shape everything else.

## Ports are the application's vocabulary

The oldest idea here is hexagonal architecture's: an application defines
**ports** for what it needs, and adapters implement them at the edge. The
detail that matters is _who names things_. A port is named by the domain —
`OrderRepository`, `Clock`, `Mailer` — never by what happens to implement it.
The application never says "Postgres"; an adapter module says it once, in a
place the application cannot see.

`di` makes that discipline structural rather than aspirational:

- `Port(id)<Shape>` is **nominal**. Two ports sharing a shape are still
  different types, so a `Cache` never satisfies a `SessionStore` by
  coincidence of structure.
- `ServiceOf<P>` types application code against the port, so a use case's
  constructor never imports an adapter.
- A module's `exports` list decides what the outside may name — the adapter's
  internals are not merely undocumented, they are
  [untypeable outside it](/explanation/modules-and-privacy).

## The obligations live in the types

The design's center of gravity is two phantom channels every provider and
module carries: `E`, every way construction can fail, and `Needs`, everything
still unmet. They obey one rule, stated once in the source and enforced by
variance:

> Capability channels are contravariant, so you may forget what you have.
> Obligation channels are covariant, so you may not forget what you owe.

You can annotate a module as exporting less than it does. You cannot annotate
away an error case, an unmet dependency, or the `Scope` a resourceful
provider owes. That asymmetry is what lets the
["UNSATISFIED DEPENDENCIES" gate](/reference/entry-points#the-gate) at each
entry point be trustworthy: nothing between declaration and build can launder
an obligation out of view.

What the types cannot see — a cycle, a duplicate provider registered in two
modules that never meet — is checked
[before any factory runs](/reference/wiring-defects), and arrives as a defect,
distinct from the failures your code models.
([Failures vs defects](/explanation/failures-vs-defects).)

## What it refuses to do

Most of the design is refusals, each buying a guarantee:

- **No decorators, no reflection, no metadata.** Wiring is plain values and
  plain types, so it survives every bundler, minifier and runtime unchanged —
  and the compiler can actually check it. `emitDecoratorMetadata` never
  enters the picture.
- **No runtime lookup surprises.** `ctx.get` only compiles for ports the
  context's type carries, so "token not found" is not an error your users can
  meet — its runtime twin exists only as a backstop behind widened types.
- **No throwing.** Every fallible operation returns an
  [unthrown](https://github.com/btravstack/unthrown) `Result`. A construction
  failure is a value you match on; a wiring bug is a defect on its own
  channel; your process never learns about either from an uncaught exception.
- **No mutable container.** There is no `container.register(...)` to call in
  test setup and forget in teardown. A module is an immutable declaration;
  swapping an adapter is [building a different composition](/how-to/swap-an-adapter),
  checked like any other.
- **No scope you can forget.** Owning a resource puts `Scope` in `Needs`;
  only [`Module.scoped`](/reference/entry-points#module-scoped-module-use-options)
  discharges it. Forgetting teardown is a compile error, not a leak found in
  production. ([Scopes and resource safety](/explanation/scopes-and-resources).)

## The cost, stated plainly

The types work hard, and it shows at the edges: a wiring mistake surfaces as
an arity error naming "UNSATISFIED DEPENDENCIES" rather than a friendly
sentence, and hovering a large module shows real channel unions. The library
is also deliberately small — one construction family, one module algebra,
three entry points, and [one name per concept](https://github.com/btravstack/di/blob/main/CONTRIBUTING.md).
If you want conditional registration DSLs, interceptors, or property
injection, this is the wrong library on purpose.

## Where it sits

`di` supersedes `demesne`, an earlier layer-based design by the same author,
and pairs naturally with the other btravstack packages —
[`entity`](https://btravstack.github.io/entity/) for the domain objects the
ports traffic in, `unthrown` for the `Result` discipline both share. None of
that is required: the library has one runtime peer, `unthrown`, and no
opinion about what your services look like.
