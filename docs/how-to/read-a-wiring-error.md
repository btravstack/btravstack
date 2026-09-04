---
title: Read a wiring error
description: How to read the compile errors this framework produces — where the actionable sentence is, why the line is wide, and what each marker means.
---

# Read a wiring error

**Task.** A composition does not compile and the error is four hundred
characters of your own contract. This page is how to read it.

## The rule: read the last line, and read it from the end

Every gate in this framework refuses a call by putting a **sentence** in the
parameter type the argument failed to match. TypeScript prints a parameter type
it could not match, so the sentence prints — and it prints **last**, because
TypeScript names the source type first and the source is your own contract,
your own piece, your own module.

So the shape is always the same:

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type '<three hundred characters of your own types>' is not assignable to type '<the sentence, and what is wrong>'.
```

The first two lines are boilerplate. The third line's **tail** is the whole
message.

**The width is not fixable from inside the packages.** It is in the type
_arguments_ — your contract, expanded — not in a name any package could alias,
which is why the marker is a whole sentence rather than a label: it is the part
you can act on, and it sits where your eye ends up.

## The markers

| Marker                                              | What happened                                                                                                                                                                                                                       | Where the fix goes                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `UNSATISFIED DEPENDENCIES — nothing provides`       | Something in the graph reads a port nothing provides. The port is named by its **id** — a bound `unit` module's own unmet needs join this same channel, since they travel published in the starter's type exactly like an import's. | `provides`, or an import that provides it. Not `exports`.                                        |
| `NO RUNTIME`                                        | The module exports no port declared over `RuntimePort`, so there is nothing to boot.                                                                                                                                                | Compose a runtime — `HttpModule`/`http()`, `TemporalModule`, `AmqpModule` — and export its port. |
| `UNSATISFIED RUNTIME PORTS`                         | The runtime resolves a port the module does not **export**.                                                                                                                                                                         | `exports`. The module's own, never a fork's.                                                     |
| `UNCOVERED CONTROLLERS` / `HANDLERS` / `ACTIVITIES` | An array of pieces leaves a contract leaf unimplemented. The leaf is named beside the marker.                                                                                                                                       | The array: add the missing piece.                                                                |
| `OVERLAPPING CONTROLLERS`                           | One piece's path sits inside another's, so both would implement the same procedures.                                                                                                                                                | The array: drop one, or mint them at sibling paths.                                              |
| `UNSLICEABLE CONTRACT KEY`                          | A top-level contract key contains a dot, which a piece path cannot encode.                                                                                                                                                          | Serve that contract with the `{ inject, sync }` form instead.                                    |

## An unmet dependency

A root that imports `http()` and forgets to provide the router:

<!-- doctest: skip — a deliberately broken composition; the gate that refuses it is pinned by packages/core/src/start.test-d.ts -->

```ts
const OrderApi = Module("OrderApi")({
  imports: [http()],
  exports: [HttpHandler],
});

await runMain(OrderApi);
```

```text
error TS2345: Argument of type 'Module<HttpHandler, ConfigInvalid, Env | OrpcRouterPort>' is not assignable to parameter of type 'Module<HttpHandler, ConfigInvalid, Env | OrpcRouterPort> & { readonly "UNSATISFIED DEPENDENCIES — nothing provides": "OrpcRouter" }'.
```

`"OrpcRouter"` is the port's **id** — what someone wrote in `Port("…")` — not
its type. That is deliberate: a starter's own generic port is its whole
contract as a type, hundreds of characters that truncate before a name is
reached. Several unmet ports print as a union: `"Logger" | "Mailer"`.

It is checked **before** the runtime arms, so a root with two mistakes is told
about the one nearest the cause. The fix is a provider, never an export.

## An uncovered piece

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Minted<…, "orders", …>' is not assignable to type 'readonly ["UNCOVERED CONTROLLERS — the contract declares a procedure this array does not cover", "billing.pay" | "users.find"]'.
```

The marker and the missing leaves arrive together, whatever the array's length:
the refusal is a tuple **as long as the array you wrote** — its head your own
elements, which match, and its last element the marker paired with what is
missing — so TypeScript lines the two up element by element and reports on the
trailing one. The three worker-side and router-side gates share the shape:
`UNCOVERED HANDLERS` names a consumer, `UNCOVERED ACTIVITIES` a workflow,
`UNCOVERED CONTROLLERS` a procedure path.

## A key the contract does not declare

This one is refused at the **mint**, not at the array, and it is a `TS2345`
rather than a `TS2769` — a much friendlier error, because it lists every path
that _is_ valid:

```text
error TS2345: Argument of type '"billing"' is not assignable to parameter of type '"orders" | "orders.place" | "users" | "users.find"'.
```

If you see this one, read it and stop: any further error on the array below it
is a consequence. The array's own gates deliberately **stand down** when a
piece's key is a union, which is what a refused mint looks like from the
outside.

## Two lines of noise you can turn off

An application that emits no declarations still type-checks declaration emit if
its `tsconfig.json` says `declaration: true` — and a composition root exported
from a module reaches a library's internal brand symbols, so **every** wiring
mistake is preceded by:

```text
error TS4023: Exported variable 'OrderApi' has or is using name 'ID' from external module "…/di/dist/index" but cannot be named.
error TS4023: … name 'SERVICE' …
```

Set `"declaration": false` in an application's `compilerOptions` and they are
gone; the error you actually made becomes the first one printed. A **library**
keeps `declaration: true`, where the check is the guarantee that its consumers
can build.

## Where to go next

- [Compile-time wiring](/explanation/compile-time-wiring) — why the gates are
  phantom markers on a parameter, and what each one costs.
- [start and StartOptions](/reference/core/start) — the kernel's own gate, arm
  by arm.
