---
title: Compile errors, not surprises
description: How the Needs channel and a phantom marker turn missing dependencies, leaked internals, forgotten scopes and a missing runtime into errors at the call site — what each one actually prints, and where the compile-time line sits.
---

<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { start } from "@btravstack/core";
class Greeter extends Port("Greeter")<{ readonly hello: () => string }> {}
-->

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
Provider(OrderRepository)({ pool: Pool }, ...)        Needs: Pool
Persistence (provides Pool, exports OrderRepository)  Needs: Scope   ← Pool netted out; Pool's acquire owes Scope
App (imports Persistence)                             Needs: Scope   ← still unpaid
```

An unpaid balance run up by a module's **own providers** may only travel if that
module **signed for it**. A provider reading a port nothing here satisfies has
to be answered by a `needs` entry, and a module that does not is refused where
it is written:

```
Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
  '{ provides: [...]; exports: [...]; }' but required in type
  '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
```

That is the first of the checks, and the only one that fires at a module rather
than at a call that builds one. It reads a module's own providers alone: a
balance inherited from an **import** travels without being signed for again,
because it is already published in that import's type. `Scope` is exempt —
nothing can provide it, so it is never something an ancestor signs over.

The remaining checks happen at the one place a graph becomes running services.

## The gate ends on the missing port

Each [entry point](/reference/di/entry-points) intersects a marker onto its
`module` parameter:

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
build<X, E, N>(module: Module<X, E, N> & DependencyGate<N>)

type DependencyGate<N> = [N] extends [never]
  ? unknown
  : { readonly "UNSATISFIED DEPENDENCIES — nothing provides": N };
```

When `Needs` is `never`, the marker is `unknown` — invisible in an
intersection — and `Module.build(mod)` is an ordinary call. When it is not,
the argument fails assignability against an object with one required
property. The gate differs per entry point only in what it
is entitled to exclude first: `scoped` excludes `Scope` (it opens a real
scope), `forkScope` excludes `Scope` and the parent context's channel (the
parent supplies those).

**What it prints, measured:**

```
error TS2345: Argument of type 'Module<Repo, never, Cfg>' is not assignable to parameter of type 'Module<Repo, never, Cfg> & { readonly "UNSATISFIED DEPENDENCIES — nothing provides": Cfg; }'.
  Property '"UNSATISFIED DEPENDENCIES — nothing provides"' is missing in type 'Module<Repo, never, Cfg>' but required in type '{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Cfg; }'.
```

Two lines, and the last thing printed is the missing port. This is the same
mechanism as `NeedsGate` at declaration time and `start`'s `StartGate` below —
one shape for every gate a composing application meets. It replaced a
conditional rest tuple whose failure was a bare arity line (`error TS2554:
Expected 3 arguments, but got 1.`) that named neither the label nor the
ports; this page used to spend two paragraphs teaching how to hand-spell the
phantom arguments to make the port print, and their deletion is the measure
of the fix.

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
laundering fails:

```
error TS2322: Type 'Module<OrderRepository, never, Database>' is not assignable to type 'Module<OrderRepository, never, never>'.
  Type 'Database' is not assignable to type 'never'.
```

That is as good as this one gets, and it is worth knowing what it does **not**
promise. The two `Module<…>` types on the first line are the whole diagnostic
in the general case: the reader diffs them. On some fixtures TypeScript
elaborates a third line naming the offending member —
`Property 'url' is missing in type 'ConfigError' but required in type 'PoolError'`
names `ConfigError` — but that is structural elaboration into whichever
property happens to differ, so two error types differing only in a `_tag` would
elaborate onto `_tag` and name nothing actionable, and two structurally
identical ones would not elaborate at all. Attaching a named wrapper to the
phantom `_error` field was tried and the re-captured diagnostic came back
**byte-identical** — TypeScript elaborates straight to the leaf mismatch and
never prints the wrapper's key. The width here is in the _type arguments_, not
in a constructor name, so nothing di can spell moves it. The opposite choice would make the same assignment reduce to
`never extends Database`, trivially true, and an annotation as innocent as a
helper's return type could silently zero the ledger. The source pins this with
type-level tests (`*.test-d.ts`), because the guarantee lives entirely in the
type system — there is nothing to observe at runtime when it holds, only when
it breaks.

## The kernel's own gate

`start` accepts a `Module<X, E, Scope | Env>` — covariance is what lets a
module needing nothing, one owing `Scope` and one reading `Env` all fit — and
then asks three questions of `X` that di's gate has no reason to ask. They
arrive as a phantom marker named `StartGate<X, UnitNeeds>`, **intersected onto
the `module` parameter** — `unknown`, and invisible, when the gate is satisfied;
a sentence otherwise. `start`, `runMain` and `@btravstack/testing`'s `Boot` all
carry it:

| Arm                         | Fires when                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO RUNTIME`                | The module exports no port declared over `RuntimePort`. A process boots exactly one runtime, and it is a service of the module — a root that forgets `HttpModule`/`http(...)` is refused here.                                                                      |
| `UNSATISFIED RUNTIME PORTS` | The runtime's declared `resolves` are not among the module's exports — the **module's alone**, never the unit module's, because `RuntimeHost.ctx` is the application context and a unit-only port does not exist at startup. No shipped starter declares any today. |
| `UNSATISFIED UNIT NEEDS`    | With `StartOptions.unit`, the unit module's needs are not covered by the module's exports, `Scope` or `Env` — `forkScope`'s gate, stated at `start`'s call site, where the parent is actually known.                                                                |

```ts
const Application = Module("Application")({
  provides: [Provider(Greeter)({ value: { hello: () => "hi" } })],
  exports: [Greeter],
});

// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
start(Application);
```

**What it prints, measured:**

```
error TS2345: Argument of type 'Module<Greeter, never, never>' is not assignable to parameter of type 'Module<Greeter, never, Env | Scope> & "NO RUNTIME — the module exports no port declared over RuntimePort"'.
  Type 'Module<Greeter, never, never>' is not assignable to type '"NO RUNTIME — the module exports no port declared over RuntimePort"'.
```

The sentence prints because the marker **rides the `module` parameter**: the
argument failed to match a parameter type, and a parameter type is something
TypeScript prints. That is the whole reason for the shape. This gate was a
trailing rest tuple until it was not, on the grounds that a conditional type in
an inference-bearing position can defer that parameter's inference and collapse
`X` or `E` to `unknown` — measured, and it does not here, because `X` still
infers from the `Module<X, …>` half of the intersection. What the tuple cost was
the diagnostic: a missing rest argument is an arity error, `NO RUNTIME` never
reached a reader, and TypeScript's related information pointed at the wrong fix
("an argument for 'options' was not provided"). di's entry points
[made the same move](#the-gate-ends-on-the-missing-port) afterwards — issue
#93 — so the two gates are the same shape again, and this time on purpose.

One thing went with the tuple: the hand-spelled bypass. `start`'s gate is still
**bypassable on purpose**, but only by a cast (`start(App as never)`), which is
the ordinary TypeScript escape rather than anything this gate offers. It takes a
deliberate act; the gate exists to catch the accident, not to be unforgeable.

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

## Why it was an arity error, and why it stopped being one

di's gate was originally a conditional rest tuple, chosen for where it puts
the blame: an arity error points at the call itself and leaves the module
type alone, where a constraint reports a failure on the whole argument, deep
in a generic instantiation. That is a real property, and it was real enough
to keep for a while.

What the tuple never was is a message. `Expected 3 arguments, but got 1` was
the entire diagnostic, and the labels a reader was told to look for lived in
the rest parameter's declaration rather than in the error. The kernel moved
first (`StartGate`, above); di followed once `NeedsGate` proved the marker
shape could end the message **on the port itself** rather than on a fixed
sentence — the one thing di's gate has to say that the kernel's does not.
**When a guarantee's only user interface is a compiler diagnostic, the
diagnostic is the design**, and four documents apologizing for one mute gate
was the measure of the old one's cost.

## The cost, stated plainly

The types work hard, and it shows at the edges: every gate's diagnostic is an
assignability error whose readable half is its last line, reached after
however many lines the caller's own types take to print. A large module's
channel unions are real types, and a diagnostic that has to print one prints it
at full width. The container is also deliberately small — one construction
family, one module algebra, three entry points, one name per concept.
Conditional registration DSLs, interceptors and property injection
are not missing features; this is the wrong library for them on purpose.

## The record

Three gate mechanisms live in this repo that a composing application meets,
not two — and before this branch, thirteen places across the documentation and
the examples named one as another. A **fourth** lives in the test harness:
`@btravstack/testing`'s `tapped`, whose `NOT EXPORTED` marker rides the
`ports` array the same way, and
[the testing reference measures it](/reference/testing#the-tap-gate).
This table is the index of the three. Where the full diagnostic is already
told above, the row points back rather than repeating it; where it is not,
the row carries the measured target — the type each diagnostic's last line
ends on, which is the payload of the whole message.

| Mechanism                                                                | Case                                                                                  | Printed target, before                                                                                                                                                                                                 | Printed target, after                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| di's own gate (`DependencyGate`, a marker on the `module` parameter)     | `Module.scoped`/`build`/`forkScope`                                                   | `Expected 3 arguments, but got 1.` — the whole message                                                                                                                                                                 | ends on the missing port — `required in type '{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Cfg; }'` ([measured above](#the-gate-ends-on-the-missing-port); moved off the rest tuple later than the rest of this table, in issue #93)                                                   |
| An unmet need at `start` (plain assignability)                           | a starter's own port, e.g. `AmqpHandlers`                                             | `'"AmqpHandlers"' is not assignable to type '"@di/Scope"'`                                                                                                                                                             | same — this was always the best diagnostic in the repo; the thirteen corrections were to the documentation calling it di's gate, not to the gate                                                                                                                                                    |
| `start`'s `StartGate` — `NO RUNTIME`                                     | [the Greeter example above](#the-kernels-own-gate)                                    | `Expected 4 arguments, but got 1.`                                                                                                                                                                                     | ends on `"NO RUNTIME — the module exports no port declared over RuntimePort"` — [full example above](#the-kernels-own-gate)                                                                                                                                                                         |
| `start`'s `StartGate` — `UNSATISFIED RUNTIME PORTS`                      | a runtime's `resolves` uncovered by the module's exports                              | `Expected 4 arguments, but got 1.`                                                                                                                                                                                     | ends on `"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`                                                                                                                                                                                                      |
| `start`'s `StartGate` — `UNSATISFIED UNIT NEEDS`                         | a unit module's needs uncovered                                                       | `Expected 4 arguments, but got 2.`                                                                                                                                                                                     | ends on `"UNSATISFIED UNIT NEEDS — the unit module needs a port the module does not export"`                                                                                                                                                                                                        |
| amqp's/temporal's composer — `UNCOVERED HANDLERS`/`UNCOVERED ACTIVITIES` | `AmqpHandlers(contract)([...])` / `TemporalActivities(contract)([...])` missing a key | ends on `'"UNCOVERED HANDLERS"'` / `'"UNCOVERED ACTIVITIES"'`                                                                                                                                                          | ends on `'"UNCOVERED HANDLERS — the contract declares a consumer this array does not cover"'` / the `ACTIVITIES` twin; the missing key prints too, as a separate diagnostic on the trailing element, once the array is as long as the marker tuple (measured: `'"orderAudit"'`, `'"fulfillOrder"'`) |
| http's composer — `UNCOVERED CONTROLLERS`                                | `api.HttpRouter(contract)([...])` missing a fragment                                  | — (this row named the keyed router's `UNDECLARED KEY` until #112 retired that form; a key the contract does not declare is now refused at `HttpController(contract, key)`, as a `TS2345` against `ControllerKeyOf<C>`) | ends on `'"UNCOVERED CONTROLLERS — the contract declares a fragment this array does not cover"'`; the missing key prints too, as a separate diagnostic on the trailing element, once the array is as long as the marker tuple (measured: `'"users"'`)                                               |

No gate's behaviour moved: the same 82 `@ts-expect-error` directives fire
after this branch as before it — none added or removed, and none now guards a
different call. (Four in `packages/core/src/start.test-d.ts` shifted line —
56→57, 66→67, 92→95, 129→131 — because the hand-spelled bypass calls below them
became `expectTypeOf` assertions; each still sits above the call it always
guarded.) What changed is which of these target strings a reader sees.
The row that did **not** change and is still the best diagnostic in the
repo — the unmet need at `start` — is the one this branch's own documentation
most often mislabelled as di's gate; naming it correctly here is the closing
half of that fix.
