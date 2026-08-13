---
title: Ports
description: "Port, Port.many, ServiceOf, and the type-only Scope — the tokens the rest of the library keys on, precisely."
---

# Ports

A port is a phantom class: never instantiated, it exists so the type system
can tell dependencies apart and the runtime can key services by id. Everything
else in the library — providers, modules, contexts — is expressed in terms of
ports.

## `Port(id)<Shape>`

```ts
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

Declares an ordinary port. The subclass-of-a-call pattern is what fixes
`Shape` while producing a concrete class you can pass around and re-use in
type positions.

- **Identity is nominal, by id.** Two ports with identical shapes but
  different ids are unrelated types; a provider for one never satisfies a
  dependency on the other. The brand is a module-private symbol, so a port
  instance type cannot be forged structurally.
- **The id is also the runtime key.** The built container is a flat map keyed
  by `portId`. Two distinct port classes sharing an id are distinct types but
  the same key — one would shadow the other, so development builds warn:
  `[di] duplicate port id "X" — one will shadow the other`. The check is
  folded out of production builds by `NODE_ENV` define-replacement.
- Declaring a port has no other runtime cost or effect.

## `Port.many(id)<Member>`

```ts
class HealthCheck extends Port.many("HealthCheck")<{
  readonly name: string;
  readonly run: () => AsyncResult<"healthy", HealthCheckFailed>;
}> {}
```

Declares a **set port**. `Member` fixes what one contribution looks like; the
port's own service — what lands in a `Context` and what `Context.get`
returns — is `readonly Member[]`.

- Several providers may target it, via
  [`Provider.member`](/reference/providers#provider-member-port); on an
  ordinary port a second provider is a
  [wiring defect](/reference/wiring-defects).
- `Context.get` returns every contribution, accumulated across module
  boundaries. No contributors is not an error — the array is empty.
- One id, one kind: the same `portId` declared ordinary in one place and
  set in another is a wiring defect.

## `ServiceOf<P>`

Recovers the service shape from a port — the type a provider must construct
and `Context.get` returns. Accepts the class or its instance type:

```ts
class GetOrderInteractor {
  constructor(orders: ServiceOf<OrderRepository>) {
    /* ... */
  }
}
```

Use it to type application code against a port without importing any adapter.
For a set port, `ServiceOf` yields the accumulated `readonly Member[]` — one
contribution's shape is the port declaration's own type argument.

## `Scope` (type only)

The phantom requirement a resourceful provider
([`acquire`/`release`, or an `onStop` hook](/reference/providers)) adds to its
`Needs`. No service ever exists for it; its only job is to make "this graph
owns un-released resources" visible to the type system, so
[`Module.build`](/reference/entry-points#module-build-module) can refuse such
a graph and [`Module.scoped`](/reference/entry-points#module-scoped-module-use-options)
can discharge it.

`Scope` is exported as a **type only** — useful in `Module<X, E, Scope>`
annotations or `Exclude<N, Scope>` computations. The class value is withheld:
it would enable exactly two things, providing `Scope` and widening it past the
type-level guards, and both are hazards. Attempting to provide it is caught at
runtime as a [wiring defect](/reference/wiring-defects) regardless.

## `AnyPort`

The structural bound every concrete port class satisfies — `portId` plus a
no-arg constructor. Use it to write helpers generic over ports:

```ts
const describe = (port: AnyPort): string => port.portId;
```

## `PortClass` / `ManyPortClass`

The return types of `Port(id)` and `Port.many(id)`. Exported so a consumer's
**declaration emit** can name them — `class X extends Port("X")<S> {}` in a
library compiled with `declaration: true` emits a base-class type the compiler
must be able to write. You are not expected to write either by hand.
