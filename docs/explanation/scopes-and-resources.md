---
title: Scopes and resource safety
description: Why Scope is a phantom port rather than a runtime object you pass around — and the close-on-every-path, LIFO, never-mask-the-failure guarantees the scope actually makes.
---

# Scopes and resource safety

A connection pool must be closed; a file handle must be released; a
subscription must be cancelled. Every DI container meets this requirement
somewhere. `di`'s answer has two unusual properties: forgetting teardown is a
**compile error**, and there is no scope object in your code at all.

## `Scope` is a debt, not a thing

Choosing the `acquire`/`release` arm (or an `onStop` hook) does not hand you
a scope to manage. It records a **debt** in the provider's `Needs` channel:
the phantom port `Scope`, a type with no service behind it — nothing
constructs one, nothing can `get` it. Like any other unmet need,
[it propagates](/explanation/compile-time-wiring) through every module that
imports the resourceful one, until it reaches an entry point.

Two entry points can pay it. [`Module.scoped`](/reference/entry-points#module-scoped-module-use-options)
and [`Module.forkScope`](/reference/entry-points#module-forkscope-parent-module-use-options)
open a real scope, run construction and your callback inside it, and close it
before their own result settles — so they exclude `Scope` from the gate.
`Module.build` opens nothing, so it excludes nothing, and a resourceful graph
reaching it is an "UNSATISFIED DEPENDENCIES" error at the call site. The leak
is refused before it exists.

Making `Scope` a port — rather than, say, a boolean flag on the module type —
is what lets the existing machinery do all the work: propagation is the
`Needs` union it already computes, discharge is an `Exclude`, and the gate is
the same gate. One concept, no parallel channel.

The phantom needs one defence the types cannot give it: `Provider(Scope)(...)`
would register a service for a port that must never have one, and a widened
type could smuggle that past any compile-time guard. The value is therefore
**not exported** — `Scope` is a type-only export — and a
[runtime defect check](/reference/wiring-defects) on the port id backs even
that.

## What the scope guarantees

Behind the entry points sits one small machine, with four properties the test
suite pins:

**Closed on every path.** Construction succeeded and `use` succeeded;
construction succeeded and `use` failed; construction failed halfway with
three of five resources acquired — in each case the scope closes, releasing
exactly what was acquired, before the entry point's result settles. Not
after: a caller that has its result can be certain teardown already ran.

**LIFO.** Finalisers run in reverse acquisition order — the transaction
before the connection, the connection before the pool — because each resource
may depend on those acquired before it still being alive. Teardown is
sequential for the same reason: a finaliser is not started until the one
after it (in acquisition order) has settled.

**A failing finaliser never masks the real failure.** If `use` failed and, on
the way down, a release also failed, the caller must see `use`'s failure —
the cause — not the release's — the symptom. So finaliser failures are
reported (to [`onTeardownError`](/reference/entry-points#scopedoptions), port-tagged)
and swallowed: close continues past them to the remaining finalisers, and the
entry point's result is never altered by one. Even a throwing _reporter_ is
swallowed; there is nowhere left to report a broken reporter to.

**Close is idempotent.** One settle, one close; a second close is a no-op.

## Why the callback shape

`Module.scoped(module, use)` insists your work happen inside a callback,
rather than returning a context-plus-`close()` pair:

```ts
const result = await Module.scoped(App, (ctx) => run(ctx)); // teardown already done
```

A returned `close()` is a leak with a delay — every early return, throw, or
forgotten `finally` between build and close leaves resources held. The
callback is the lexical guarantee `finally` only approximates: there is no
program text where the graph is up and teardown is not already scheduled on
every exit path. The cost is honest and visible — a `Context` must not
outlive its callback, so long-lived holds belong in long-lived scopes (a
server's `scoped` spans the server's life, with
[per-request forks](/how-to/request-scope) inside it).

## Forks: scopes that nest without owning each other

`Module.forkScope` layers a short-lived scope over a built parent. The
load-bearing detail is what it does **not** do: the parent's services are
seeded in, not re-constructed, so none of the parent's finalisers register on
the fork. Closing a fork releases only the fork's own acquisitions — the
transaction, never the pool — and concurrent sibling forks share the parent
without sharing anything else. Lifetime nesting (fork inside `scoped`) comes
from the call structure itself: the parent's close cannot run until its
callback — which contains every fork — has settled.
