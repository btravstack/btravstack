---
title: Ports
description: "Port, ServiceOf, the type-only Scope, and the class and instance types a consumer's declaration emit needs — the tokens the rest of the container keys on, precisely."
---

<!-- doctest: prelude
import { Port, type AnyPort, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";
type Order = { readonly id: string; readonly quantity: number };
class OrderNotFound extends TaggedError("OrderNotFound")<{ readonly id: string }> {}
-->

# Ports

> **Reference.** A complete, structured description of the port surface of
> `@btravstack/di`. For the reasoning — why identity is nominal, why `Scope`
> is a phantom — see [Compile errors, not surprises](/explanation/compile-time-wiring)
> and [Scopes and resource safety](/explanation/scopes-and-resources). Full
> signatures: [API reference](/api/di/).

A port is a phantom class: never instantiated, it exists so the type system
can tell dependencies apart and the runtime can key services by id.
Everything else in the container — providers, modules, contexts — is
expressed in terms of ports.

## `Port(id)<Service>`

```ts
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

Declares an ordinary port. The subclass-of-a-call pattern is what fixes
`Service` while producing a concrete class you can pass around and reuse in
type positions.

| Property     | Value                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | Nominal, by `id`. Two ports with identical shapes but different ids are unrelated types; a provider for one never satisfies a dependency on the other. The brand is a module-private symbol, so a port instance type cannot be forged structurally. |
| Runtime key  | The `id`, as the static `portId`. The built container is a flat map keyed by it.                                                                                                                                                                    |
| Duplicate id | Two distinct classes sharing an id are distinct types but one key — one would shadow the other. Development builds warn once per id: `[di] duplicate port id "X" — one will shadow the other`. Folded out when `NODE_ENV` is `production`.          |
| Cost         | None beyond the class object. Declaring a port runs no factory and allocates no service.                                                                                                                                                            |

## `ServiceOf<T>`

Recovers the service shape from a port — the type a provider must construct
and `Context.get` returns. Accepts the class or its instance type:

```ts
class GetOrderInteractor {
  private readonly orders: ServiceOf<OrderRepository>;
  constructor(orders: ServiceOf<OrderRepository>) {
    this.orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.orders.findById(id);
  }
}
```

Use it to type application code against a port without importing any adapter.

## `Scope` (type only)

The phantom requirement a resourceful provider
([`acquire`/`release`, or an `onStop` hook](/reference/di/providers)) adds to
its `Needs`. No service ever exists for it; its only job is to make "this
graph owns un-released resources" visible to the type system, so
[`Module.build`](/reference/di/entry-points#module-build-module) can refuse
such a graph and
[`Module.scoped`](/reference/di/entry-points#module-scoped-module-use-options)
can discharge it. [`start`](/reference/core/start) discharges it the same way,
for the whole process.

`Scope` is exported as a **type only** — for `Module<X, E, Scope>` annotations
or `Exclude<N, Scope>` computations. The class value is withheld: it would
enable exactly two things, providing `Scope` and widening it past the
type-level guards, and both are hazards. Providing it is caught at runtime as a
[wiring defect](/reference/di/wiring-defects) regardless.

## `AnyPort`

The structural bound every concrete port class satisfies — `portId`, an
optional `many`, and a no-arg constructor returning some port instance. Use it
to write helpers generic over ports:

```ts
const describePort = (port: AnyPort): string => port.portId;
```

## `PortInstance<Id, Service>` and `PortClassOf<Id, Service>`

The two names a **helper that mints a port for its caller** needs.
`PortInstance<Id, Service>` is the type that appears in a `Needs` or `Exports`
union — the instance type of a port class. `PortClassOf<Id, Service>` is a
concrete port class with both fixed: `{ portId: Id; new (): PortInstance<Id,
Service> }`.

```ts
const mintConfigPort = <const Name extends string, S>(
  name: Name,
): PortClassOf<Name, S> => class extends Port(name)<S> {};
```

The class expression `class extends Port(id)<S> {}` has an anonymous type that
declaration emit cannot name across packages; `PortClassOf` is its nameable
spelling. This is what `Config.provider("Name")(schema)` returns as the type
of `provider.port`, and how the starters spell their own fixed ports —
`api.HttpRouter(contract)(…)` returns `PortClassOf<"HttpRouter", …>`,
`TemporalActivities` / `AmqpHandlers` a `PortClassOf<"TemporalActivities", …>`
/ `PortClassOf<"AmqpHandlers", …>` typed for the contract — and what a
consumer that **exports** such a provider needs so its own `.d.ts` can be
written. Naming either type forges
nothing: the brand keys stay private, so a value still cannot be hand-rolled.

## `PortClass<Id>`

The return type of `Port(id)`. Exported so a consumer's **declaration emit**
can name it — `class X extends Port("X")<S> {}` in a library compiled with
`declaration: true` emits a base-class type the compiler must be able to
write. You are not expected to write it by hand.

## Where the rest lives

| Export                                                              | Page                                       |
| ------------------------------------------------------------------- | ------------------------------------------ |
| `Provider`, `AnyProvider`                                           | [Providers](/reference/di/providers)       |
| `Module`, `AnyModule`, `Exportable`                                 | [Modules](/reference/di/modules)           |
| `Module.build` / `scoped` / `forkScope`, `ScopedOptions`, `Context` | [Entry points](/reference/di/entry-points) |
