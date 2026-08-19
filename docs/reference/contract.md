---
title: "@btravstack/contract"
description: The contract-level auth marker — auth(), Authenticated, PrincipalKey, PrincipalOf and isAuthenticated — what it puts on a contract node, and what it deliberately does not.
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
procedure — to say _"this requires an authenticated principal"_, readable by
both the client that imports the contract and the server that implements it.
Nothing here talks to oRPC, HTTP, AMQP or Temporal: it is a plain marker over
`WeakSet` identity, transport-agnostic by construction.

## Exports

`packages/contract/src/index.ts` exports exactly this:

| Export                | Kind  | What it is                                                                                                                                           |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                | value | `auth<P>(): { authenticated: <T extends object>(node: T) => Authenticated<T, P> }` — mints the combinator for one contract's principal type `P`      |
| `isAuthenticated`     | value | `(node: object) => boolean` — whether **this exact node** was marked                                                                                 |
| `Authenticated<T, P>` | type  | `T & { readonly [PrincipalKey]: P }` — `T`'s own keys plus one phantom key that exists only for the type checker                                     |
| `PrincipalKey`        | type  | `typeof PRINCIPAL`, the marker's key — exported so a consumer's mapped type can `Exclude<keyof C, PrincipalKey>` and land on the contract's own keys |
| `PrincipalOf<T>`      | type  | `T extends { readonly [PrincipalKey]: infer P } ? P : never` — the principal a node was marked with, `never` when it carries none                    |

## `auth<P>()`

Call it once per contract, destructure `authenticated`, and apply it to a
record of procedures (which protects every procedure beneath it) or to a
single procedure (which protects itself):

```ts
import { auth } from "@btravstack/contract";
import { oc, type } from "@orpc/contract";

export type Principal = { readonly userId: string; readonly tenantId: string };

const { authenticated } = auth<Principal>();

const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<{ readonly id: string }>()),
};

export const contract = {
  orders: authenticated(ordersContract),
  customers: {
    find: oc
      .input(type<{ readonly id: string }>())
      .output(type<{ readonly name: string }>()),
  },
};
```

The type argument is the whole point of the two-call shape: `P` is stated once,
where the contract declares what a caller looks like, and every marked node
under that contract carries the same principal type. A second contract with a
different principal calls `auth` again.

## `PrincipalOf` and `isAuthenticated`

`PrincipalOf` recovers the principal off a node at the type level;
`isAuthenticated` answers the same question at runtime, for one node:

```ts
import { auth, isAuthenticated, type PrincipalOf } from "@btravstack/contract";
import { oc, type } from "@orpc/contract";

type Principal = { readonly userId: string };
const { authenticated } = auth<Principal>();

const quote = authenticated(
  oc
    .input(type<{ readonly id: string }>())
    .output(type<{ readonly total: number }>()),
);

export type QuotePrincipal = PrincipalOf<typeof quote>; // Principal
export const isProtected: boolean = isAuthenticated(quote); // true
```

`isAuthenticated` answers for **one node only**. Ancestry — a marked parent
implying a marked child — is the caller's to carry: this package tracks nodes,
not trees. `@btravstack/http`'s router walk carries an `inherited` flag for
exactly that, mirroring what the types do when a marked record pushes its
marker onto each child.

## Three load-bearing properties

**Zero dependencies and zero peers.** Nothing here imports oRPC, `di`, `core`
or `unthrown`. That is what lets a client take a contract without pulling in
the server that implements it, and what would let an AMQP or Temporal contract
reuse the same combinator: the marker has no opinion about which transport
reads it.

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
- **It does not authenticate.** Turning a request into a principal is
  `@btravstack/http`'s `HttpAuthenticator`, and what a token means is the
  application's.
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
package so an application holds a single copy in the first place. See
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
