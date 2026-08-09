---
title: Failures vs defects
description: Nothing throws — construction failures are values on the error channel, wiring bugs are defects on their own channel, and why the two must never meet.
---

# Failures vs defects

Every fallible operation in `di` returns an
[unthrown](https://github.com/btravstack/unthrown) `Result`. That sentence is
easy to read as a style preference — `Err` instead of `throw`. The design
carries more weight than that: it rests on keeping two kinds of "went wrong"
on **separate channels**, because they demand opposite responses.

## Two kinds of wrong

A **failure** is an outcome your program models. The database URL is unset;
the order does not exist; the connection could not be acquired. These appear
in a provider's `make`/`acquire` signature as typed errors, join the module's
`E` channel, and arrive at the entry point as the `Err` arm of its `Result` —
where the caller branches on them, because branching on them is the program:

```ts
const outcome = await Module.scoped(App, use).match({
  ok: (value) => respond(value),
  errCases: (m) =>
    m
      .with(P.tag("ConfigError"), (e) => exitWith(`bad config: ${e.reason}`))
      .with(P.tag("OrderNotFound"), (e) => notFound(e.id)),
  defect: (cause) => alertAndCrash(cause),
});
```

A **defect** is a bug. A [dependency cycle](/reference/wiring-defects), two
providers for one port, an exception thrown inside a factory that promised a
`Result`. No branch of your program is the correct response to a bug — the
correct response is to surface it loudly, with its cause intact, to a human.
Defects travel on unthrown's separate defect channel and land in the one
`defect` arm.

## Why the channels must not merge

Merging them — the classic `catch (e)` that sees everything — forces every
caller to answer a question it cannot answer: _is this `e` an outcome or a
bug?_ Handle-everything turns wiring bugs into quietly-handled "errors"
(a cycle retried three times, then logged as a config problem); rethrow-
everything turns modeled outcomes into crashes. The type system can only help
with the failures half, and only if that half is closed: `E` is a union of
**named** errors, `errCases` matching is exhaustive, and adding a new failure
to a provider is a compile error at every unhandled match site.

The defect channel is what keeps `E` honest. Because bugs have somewhere else
to go, nothing needs an `| unknown` escape hatch in the error union — and an
`E` without escape hatches is the difference between "the compiler checks my
error handling" and "the compiler checks the errors I remembered to list."

## Where `di` draws the line

The library's own sorting, concretely:

| Event                                                                                    | Channel                                                                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `make`/`acquire` returns `Err(...)`                                                      | Failure — the entry point's `E`                                                                                                  |
| A factory **throws** despite promising a `Result`                                        | Defect — a broken contract is a bug                                                                                              |
| Cycle, duplicate provider, provider for `Scope`, missing provider, set/ordinary conflict | Defect — [wiring bugs](/reference/wiring-defects), pre-construction                                                              |
| A `release`/`onStop` fails during close                                                  | Neither — [reported and swallowed](/explanation/scopes-and-resources), so teardown finishes and the true failure is never masked |
| Duplicate port id across two port classes                                                | Development-time warning — the build cannot even see it                                                                          |

The last two rows are the instructive ones. Teardown failures get a
_reporting_ path rather than a channel, because propagating them would
overwrite the failure that caused the unwind — a masking bug baked into the
API. And wiring defects are raised **before any factory runs**, so a defect
never arrives with half a graph's side effects behind it.

## What this asks of your code

Inside providers, the contract is symmetrical: model your failures as tagged
errors and return them (`Err(new ConfigError({...}))`); let genuine bugs
escape as throws, and the boundary will file them as defects rather than
folding them into `E`. The repo enforces its half of the bargain mechanically
— unthrown's lint rules forbid stray throws outside documented defect paths —
and the same rules are available to consumers
([`@unthrown/oxlint`](https://github.com/btravstack/unthrown)).

In tests, the channels stay distinct to the end:
[`@unthrown/vitest`](https://github.com/btravstack/unthrown)'s `toBeErr`
asserts a modeled failure, `toBeDefect` a bug — the library's own suite uses
`toBeDefect()` to pin that a cycle is a defect and never an `Err`.
