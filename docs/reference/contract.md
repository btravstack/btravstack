---
title: "@btravstack/contract"
description: The contract-level auth marker — authenticated(), Authenticated, PrincipalKey, IsMarked and isAuthenticated — what it puts on a contract node, and what it deliberately does not.
---

# @btravstack/contract

> **Reference.** A complete, structured description of the contract marker's
> public surface: every export of `@btravstack/contract`, what a marked node
> carries and what reads it. For the task, see
> [Protect a procedure](/how-to/protect-a-procedure); for how the HTTP starter
> turns the marker into a typed `opts.context.principal`, see
> [`@btravstack/http`](/reference/http). Generated signatures are under
> [API reference](/api/contract/).

A marker a contract puts on a node — a record of procedures, or a single
procedure — to say _"this requires an authenticated caller"_, readable by
both the client that imports the contract and the server that implements it.
Nothing here talks to oRPC, HTTP, AMQP or Temporal: it is a plain marker over
`WeakSet` identity, transport-agnostic by construction.

**The contract says _whether_ a route is protected; the application's
`httpAuth<Identity>()` says _what_ the principal is.** No identity type is
named here at all, so nothing about the server's view of a caller reaches a
client.

## Exports

`packages/contract/src/index.ts` exports exactly this:

| Export             | Kind  | What it is                                                                                                                                           |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticated`    | value | `<T extends object>(node: T) => Authenticated<T>` — marks a contract node as requiring an authenticated caller                                       |
| `isAuthenticated`  | value | `(node: object) => boolean` — whether **this exact node** was marked                                                                                 |
| `Authenticated<T>` | type  | `T & { readonly [PrincipalKey]: true }` — `T`'s own keys plus one phantom key that exists only for the type checker                                  |
| `PrincipalKey`     | type  | `typeof PRINCIPAL`, the marker's key — exported so a consumer's mapped type can `Exclude<keyof C, PrincipalKey>` and land on the contract's own keys |
| `IsMarked<T>`      | type  | `T extends { readonly [PrincipalKey]: true } ? true : false` — whether **this exact node** carries the marker, as a yes/no rather than a type        |

## `authenticated(node)`

One export, no factory and no type parameter. Apply it to a record of
procedures (which protects every procedure beneath it) or to a single
procedure (which protects itself):

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const ordersContract = {
  place: oc
    .input(z.object({ id: z.string(), quantity: z.number() }))
    .output(z.object({ id: z.string() })),
};

export const contract = {
  orders: authenticated(ordersContract),
  customers: {
    find: oc
      .input(z.object({ id: z.string() }))
      .output(z.object({ name: z.string() })),
  },
};
```

There is nothing to state twice, and nothing about identity to keep in step
between two contracts: the marker carries no principal, so `orders` above says
only that a caller must be authenticated.

## `IsMarked` and `isAuthenticated`

`IsMarked` answers the question at the type level; `isAuthenticated` answers
the same question at runtime, for one node:

```ts
import {
  authenticated,
  isAuthenticated,
  type IsMarked,
} from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const quote = authenticated(
  oc
    .input(z.object({ id: z.string() }))
    .output(z.object({ total: z.number() })),
);

export type QuoteIsMarked = IsMarked<typeof quote>; // true
export const isProtected: boolean = isAuthenticated(quote); // true
```

`isAuthenticated` answers for **one node only**. Ancestry — a marked parent
implying a marked child — is the caller's to carry: this package tracks nodes,
not trees. `@btravstack/http`'s router walk carries an `inherited` flag for
exactly that, mirroring what the types do when a marked record pushes its
marker onto each child.

## The contract says whether; the application says what

Nothing here names an identity type, so there is nothing in the contract to
keep minimal and nothing in it to leak. What a principal actually **is** is
stated once, server-side, by `@btravstack/http`'s
[`httpAuth<Identity>()`](/reference/http) — and a handler minted from that
factory sees it with no annotation of its own.

Two things follow. Enriching what a deployment knows about its callers —
roles, an org tier, an internal id — is never a contract change and reaches no
client. And the gate pairing a router with an authenticator compares the
**router's** identity against the **authenticator's**, both of which come from
the same `httpAuth` call, rather than either against the contract.

A marked fragment reached through the top-level `HttpController` — no factory —
types `principal: never`, so every read of it is a compile error. That is the
signal to use the factory, not a fallback.

## Three load-bearing properties

**Zero dependencies and zero peers.** Nothing here imports oRPC, `di`, `core`
or `unthrown`. That is what lets a client take a contract without pulling in
the server that implements it, and what would let an AMQP or Temporal contract
reuse the same marker: it has no opinion about which transport reads it.

**The combinator returns the node unchanged and sets no property on it.**
`authenticated(node) === node`, with nothing added — `PRINCIPAL` is `declare`d
and never assigned, so it exists only in the type system. There is no key for
oRPC's `implement()` to walk as a procedure and nothing for its builders to
strip; the mark lives in a `WeakSet` keyed by identity, shared across copies of
this package (see the warning below).

**Applied after a builder chain is finished, never inside one.**
`authenticated` wraps a finished node — the last call in a chain, or a whole
record of finished nodes. Applied mid-chain it is lost, because
`oc.router(...)` rebuilds every node: lost on **both** sides at once, the type
and the runtime mark together, which makes it a dropped protection rather than
a bypass. No oRPC builder has to know the marker exists.

## What it does not do

- **It does not enforce anything.** An unmarked node is public, and forgetting
  the marker fails nothing — the contract makes a protected route _legible_,
  not mandatory. Opt-in by construction; see
  [Protect a procedure](/how-to/protect-a-procedure).
- **It does not authenticate, and it does not name a principal.** Turning a
  request into a principal is `@btravstack/http`'s `HttpAuthenticator`, what
  that principal's type is, is `httpAuth<Identity>()`, and what a token means
  is the application's.
- **It does not model authorization.** Who a caller is, not what they may do.

## Peer dependencies

None, and no runtime dependencies either. `pnpm add @btravstack/contract`, and
that is the whole install. Node `>=20`.

::: warning One copy — and a second one is a compile error, not an open route
`PrincipalKey` is a `unique symbol`, so two copies of this package mint two
different brands: a contract marked against one does not type as marked in the
other. The **runtime** registry does not split that way — it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/marked")`, so every copy
reads and writes one `WeakSet`.

That asymmetry is deliberate. A module-private set would make a second copy
silent: `isAuthenticated` false everywhere, no authenticator required, and a
marked route **served open**. Sharing the registry makes the two halves fail
together, and the type half fails loudly. `@btravstack/http` peers on this
package so an application holds a single copy in the first place.

`PRINCIPAL` is also never exported as a value, and must stay that way: a
nameable brand could be written onto a contract node by hand without the
matching `WeakSet` entry — typed as protected, unmarked at runtime, so no
authenticator is demanded and a handler reads a principal nothing injected.
See
[Peer dependencies](/explanation/peer-dependencies).
:::

## See also

- [Protect a procedure](/how-to/protect-a-procedure) — mark, authenticate,
  compose.
- [`@btravstack/http`](/reference/http) — `HttpAuthenticator`,
  `AuthenticatorPort`, `Unauthenticated`, and what a marked leaf's handler
  receives.
- [Order API (HTTP)](/examples/order-api) — a contract with one marked
  fragment and one public one.
