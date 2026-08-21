---
title: Scopes and resource safety
description: Why Scope is a phantom port rather than a runtime object you pass around, the close-on-every-path, LIFO, never-mask-the-failure guarantees the scope makes, and how the kernel widens one scope to the whole process.
---

# Scopes and resource safety

> **Explanation.** This page explains how `di` makes forgetting teardown a
> compile error without a scope object in your code, which failures travel on
> which channel, and how `start` turns the same scope into a process. For the
> tasks, see [Manage a resource's lifetime](/how-to/manage-a-resource) and
> [Open a per-request scope](/how-to/open-a-per-request-scope).

A connection pool must be closed; a file handle must be released; a
subscription must be cancelled. Every DI container meets this requirement
somewhere. `di`'s answer has two unusual properties: forgetting teardown is a
**compile error**, and there is no scope object in your code at all.

## `Scope` is a debt, not a thing

Choosing the `acquire`/`release` arm (or an `onStop` hook) does not hand you a
scope to manage. It records a **debt** in the provider's `Needs` channel: the
phantom port `Scope`, a type with no service behind it — nothing constructs
one, nothing can `get` it. Like any other unmet need,
[it propagates](/explanation/compile-time-wiring) through every module that
imports the resourceful one, until it reaches an entry point.

Two entry points can pay it.
[`Module.scoped`](/reference/di/entry-points#module-scoped-module-use-options)
and
[`Module.forkScope`](/reference/di/entry-points#module-forkscope-parent-module-use-options)
open a real scope, run construction and your callback inside it, and close it
before their own result settles — so they exclude `Scope` from the gate.
`Module.build` opens nothing, so it excludes nothing, and a resourceful graph
reaching it is refused at the call site by the
[`UNSATISFIED DEPENDENCIES` gate](/reference/di/entry-points#the-gate). The leak
is refused before it exists.

Making `Scope` a port — rather than, say, a boolean flag on the module type —
is what lets the existing machinery do all the work: propagation is the
`Needs` union it already computes, discharge is an `Exclude`, and the gate is
the same gate. One concept, no parallel channel.

The phantom needs one defence the types cannot give it: `Provider(Scope)(...)`
would register a service for a port that must never have one, and a widened
type could smuggle that past any compile-time guard. The value is therefore
**not exported** — `Scope` is a type-only export — and a
[runtime defect check](/reference/di/wiring-defects) on the port id backs even
that.

## What the scope guarantees

Behind the entry points sits one small machine, with four properties the test
suite pins:

**Closed on every path.** Construction succeeded and `use` succeeded;
construction succeeded and `use` failed; construction failed halfway with
three of five resources acquired — in each case the scope closes, releasing
exactly what was acquired, before the entry point's result settles. Not after:
a caller that has its result can be certain teardown already ran.

**LIFO.** Finalisers run in reverse acquisition order — the transaction before
the connection, the connection before the pool — because each resource may
depend on those acquired before it still being alive. Teardown is sequential
for the same reason: a finaliser is not started until the one after it (in
acquisition order) has settled.

**A failing finaliser never masks the real failure.** If `use` failed and, on
the way down, a release also failed, the caller must see `use`'s failure — the
cause — not the release's — the symptom. So finaliser failures are reported
(to [`onTeardownError`](/reference/di/entry-points#scopedoptions),
port-tagged) and swallowed: close continues past them to the remaining
finalisers, and the entry point's result is never altered by one. Even a
throwing _reporter_ is swallowed; there is nowhere left to report a broken
reporter to.

**Close is idempotent.** One settle, one close; a second close is a no-op.

## Two kinds of wrong, two channels

The reporting path above is one row of a larger sorting the container does
deliberately. A **failure** is an outcome your program models — the database
URL is unset, the connection could not be acquired. It appears in a
provider's `make`/`acquire` signature as a typed error, joins the module's `E`
channel, and arrives at the entry point as the `Err` arm of its `Result`,
where the caller branches on it, because branching on it _is_ the program. A
**defect** is a bug — a dependency cycle, two providers for one port, a
factory that threw despite promising a `Result`. No branch of your program is
the correct response to a bug; the correct response is to surface it loudly,
with its cause intact. Defects travel on unthrown's separate defect channel
and land in the one `defect` arm.

| Event                                                                                    | Channel                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `make`/`acquire` returns `Err(...)`                                                      | Failure — the entry point's `E`                                                             |
| A factory **throws** despite promising a `Result`; an `onStart` throws or rejects        | Defect — a broken contract is a bug                                                         |
| Cycle, duplicate provider, provider for `Scope`, missing provider, set/ordinary conflict | Defect — [wiring bugs](/reference/di/wiring-defects), pre-construction                      |
| A `release`/`onStop` fails during close                                                  | Neither — reported and swallowed, so teardown finishes and the true failure is never masked |
| Duplicate port id across two port classes                                                | Development-time warning — the build cannot even see it                                     |

Merging the two channels — the classic `catch (e)` that sees everything —
forces every caller to answer a question it cannot: _is this `e` an outcome or
a bug?_ Keeping them apart is what keeps `E` honest: because bugs have
somewhere else to go, nothing needs an `| unknown` escape hatch in the error
union, and an `E` without escape hatches is the difference between "the
compiler checks my error handling" and "the compiler checks the errors I
remembered to list". The kernel keeps the split to the end: a modeled startup
`Err` is exit code `1` (or `78` for configuration), a defect is `70`. See
[Nothing throws](/explanation/nothing-throws).

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
every exit path. The cost is honest and visible — a `Context` must not outlive
its callback, so long-lived holds belong in long-lived scopes: a server's
`scoped` spans the server's life, with per-request forks inside it.

## Forks: scopes that nest without owning each other

`Module.forkScope` layers a short-lived scope over a built parent. The
load-bearing detail is what it does **not** do: the parent's services are
seeded in, not re-constructed, so none of the parent's finalisers register on
the fork. Closing a fork releases only the fork's own acquisitions — the
transaction, never the pool — and concurrent sibling forks share the parent
without sharing anything else. Lifetime nesting (fork inside `scoped`) comes
from the call structure itself: the parent's close cannot run until its
callback — which contains every fork — has settled.

## The process is a scope too

`start` is `Module.scoped` with the callback written for you. The application
module goes in as a `Module<X, E, Scope | Env>`; the kernel opens the
application scope as it builds, hands the built context to the one runtime,
and closes the scope on **every** path out — a signal, `stop()`, an uncaught
exception, a runtime that stopped on its own — before `RunningApp.exited`
settles. `StartOptions.unit` is `Module.forkScope` written for you: one fork
per unit, opened as the unit opens and closed as it closes, so no handler ever
calls `forkScope` itself. What a finaliser reports on the way down is not
swallowed into silence at that level: an application-scope failure becomes a
`teardownError` event and an entry in `ExitReport.teardownErrors`, and
`runMain` exits `2` over it; a unit-scope failure is the event alone, since a
per-unit list would grow without bound. What
happens _between_ the signal and the close — the readiness flip, the delay,
the drain deadline — is the kernel's own contribution:
[Draining, in three beats](/explanation/draining-in-three-beats).
