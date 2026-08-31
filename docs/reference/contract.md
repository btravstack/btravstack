---
title: "@btravstack/contract"
description: The contract-level auth marker — authenticated(), Requirement, Requirements, OneScheme, Authenticated, PrincipalKey, IsMarked, RequirementsOf and isAuthenticated — what it puts on a contract node, and what it deliberately does not.
---

# @btravstack/contract

> **Reference.** A complete, structured description of the contract marker's
> public surface: every export of `@btravstack/contract`, what a marked node
> carries and what reads it. For the task, see
> [Protect a procedure](/how-to/protect-a-procedure); for how the HTTP starter
> turns the marker into a typed `opts.context.principal`, see
> [`@btravstack/http-server`](/reference/http-server). Generated signatures are under
> [API reference](/api/contract/).

A marker a contract puts on a node — a record of procedures, or a single
procedure — to say _"this requires a caller satisfying one of these security
requirements"_, readable by both the client that imports the contract and the
server that implements it. A requirement is OpenAPI's own shape: a security
scheme's name, mapped to the scopes it must grant. Nothing here talks to oRPC,
HTTP, AMQP or Temporal: it is a plain marker over `WeakMap` identity,
transport-agnostic by construction.

**The contract says _which schemes_ protect a route and _which scopes_ each
must grant; the application's `defineHttp({ authenticators })` says _what each
scheme resolves to_.** No identity type is named here at all, so nothing about
the server's view of a caller reaches a client.

## Exports

`packages/contract/src/index.ts` exports exactly this:

| Export                | Kind  | What it is                                                                                                                                                                                                       |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticated`       | value | `<const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> }>(...requirements: R) => <T extends object>(node: T) => Authenticated<T, R>` — curried; marks a node with the requirements it names |
| `isAuthenticated`     | value | `(node: object) => Requirements \| undefined` — what **this exact node** requires, or `undefined` when nobody marked it                                                                                          |
| `Requirement`         | type  | `Readonly<Record<string, readonly string[]>>` — one security scheme's name mapped to the scopes it must grant; a second key is refused at the mark                                                               |
| `Requirements`        | type  | `readonly Requirement[]` — ORed, tried in declaration order                                                                                                                                                      |
| `OneScheme<Q>`        | type  | `SeveralKeys<keyof Q> extends false ? Q : never` — the refusal above as a constraint a consumer can intersect into a requirement-typed surface of its own                                                        |
| `Authenticated<T, R>` | type  | `T & { readonly [PrincipalKey]: R }` — `T`'s own keys plus one phantom key holding the exact requirements, for the type checker only                                                                             |
| `PrincipalKey`        | type  | `typeof PRINCIPAL`, the marker's key — exported so a consumer's mapped type can `Exclude<keyof C, PrincipalKey>` and land on the contract's own keys                                                             |
| `IsMarked<T>`         | type  | `T extends { readonly [PrincipalKey]: Requirements } ? true : false` — whether **this exact node** carries the marker, as a yes/no rather than a type                                                            |
| `RequirementsOf<T>`   | type  | the exact `Requirements` **this exact node** was marked with, `never` when it is unmarked                                                                                                                        |

## `authenticated(...requirements)(node)`

**Curried.** The first call takes one or more `Requirement`s — a scheme name
mapped to the scopes it must grant — and returns the function that marks a
node. Apply that to a record of procedures (the **default** for every procedure
beneath it) or to a single procedure (which **replaces** that default for
itself):

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.string(), quantity: z.number() }))
    .output(z.object({ id: z.string() })),

  // Its own mark replaces the group default: a `user` token granting the
  // `orders:export` scope, or a `service` token needing no scope at all.
  export: authenticated(
    { user: ["orders:export"] },
    { service: [] },
  )(oc.output(z.object({ csv: z.string() }))),
});

export const contract = {
  orders: ordersContract,
  customers: {
    find: oc
      .input(z.object({ id: z.string() }))
      .output(z.object({ name: z.string() })),
  },
};
```

Three rules, and they are OpenAPI's own:

- **Requirements are ORed**, tried in the order given: the first one a caller
  satisfies wins.
- **A requirement names one scheme**, and a second key is a **compile error**
  rather than a documented caveat. AND-within-a-requirement is deliberately
  not modelled — requiring two credentials at once would put a record rather
  than a single identity on the handler — and the discrepancy runs the wrong
  way: OpenAPI reads `{ user: [], mtls: [] }` as AND while the starter walks
  the entries and takes the first that satisfies, which is OR, so a
  requirement copied out of an OpenAPI document would silently admit a caller
  presenting either. A composite scheme models it where it is genuinely
  needed.
- **Nearest mark wins.** A marked record is a default; a marked procedure
  beneath it replaces that default for itself rather than adding to it.

Nothing about identity is stated here, and nothing has to be kept in step
between two contracts: `{ user: [] }` says a caller must present the `user`
scheme, not who a `user` is.

## `IsMarked`, `RequirementsOf` and `isAuthenticated`

`IsMarked` answers yes/no at the type level, `RequirementsOf` reads the exact
requirements back, and `isAuthenticated` answers the same question at runtime,
for one node:

```ts
import {
  authenticated,
  isAuthenticated,
  type IsMarked,
  type Requirements,
  type RequirementsOf,
} from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const quote = authenticated({ user: ["quotes:read"] })(
  oc
    .input(z.object({ id: z.string() }))
    .output(z.object({ total: z.number() })),
);

export type QuoteIsMarked = IsMarked<typeof quote>; // true
export type QuoteNeeds = RequirementsOf<typeof quote>; // [{ user: ["quotes:read"] }]
export const required: Requirements | undefined = isAuthenticated(quote);
```

`isAuthenticated` answers for **one node only**, and answers `undefined` — not
an empty array — when nobody marked it, so "public" cannot be confused with
"protected by nothing satisfiable". Ancestry — a marked parent implying a
marked child — is the caller's to carry: this package tracks nodes, not trees.
`@btravstack/http-server`'s router walk carries the inherited requirements for exactly
that, mirroring what the types do when a marked record pushes its requirements
onto each child that declares none of its own.

## The contract says which schemes; the application says what each one is

Nothing here names an identity type, so there is nothing in the contract to
keep minimal and nothing in it to leak. What each scheme resolves to is stated
once, server-side, by `@btravstack/http-server`'s
[`defineHttp({ authenticators })`](/reference/http-server) — and a handler minted from
that call sees it with no annotation of its own.

Two things follow. Enriching what a deployment knows about its callers —
roles, an org tier, an internal id — is never a contract change and reaches no
client. And there is no identity pair left to compare: declaring a scheme and
implementing it are the same act, so a scheme the contract names with no
authenticator behind it is di's own unmet need on `HttpAuthenticator:<scheme>`,
not a gate either package writes.

A marked fragment reached through anything but a `defineHttp` call types
`principal: never`, so every read of it is a compile error. That is the signal
to use the factory, not a fallback.

## Three load-bearing properties

**Zero dependencies and zero peers.** Nothing here imports oRPC, `di`, `core`
or `unthrown`. That is what lets a client take a contract without pulling in
the server that implements it, and what would let an AMQP or Temporal contract
reuse the same marker: it has no opinion about which transport reads it.

**The combinator returns the node unchanged and sets no property on it.**
`authenticated(...requirements)(node) === node`, with nothing added —
`PRINCIPAL` is `declare`d
and never assigned, so it exists only in the type system. There is no key for
oRPC's `implement()` to walk as a procedure and nothing for its builders to
strip; the mark lives in a `WeakMap` keyed by identity, mapping each node to
the requirements it was marked with, shared across copies of
this package (see the warning below).

**Applied after a builder chain is finished, never inside one.**
`authenticated(...requirements)` wraps a finished node — the last call in a chain, or a whole
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
  request into a principal is `@btravstack/http-server`'s `HttpAuthenticator`, what
  each scheme resolves to is `defineHttp({ authenticators })`, and what a token
  means is the application's.
- **It does not check a scope either.** It declares one; comparing a
  credential's granted scopes against it — and answering `403` rather than
  `401` — is the starter's.
- **It does not model resource-dependent authorization.** A scope is a property
  of the credential and is answerable before dispatch, which is why it is here.
  "Is this caller the order's owner?" is not, and stays in the handler.
- **It carries no OpenAPI document metadata.** A scheme's own definition —
  `type: http`, `bearerFormat`, an OAuth flow — belongs beside the contract,
  not in the marker.

## Peer dependencies

None, and no runtime dependencies either. `pnpm add @btravstack/contract`, and
that is the whole install. Node `>=22`.

::: warning One copy — and a second one is a compile error, not an open route
`PrincipalKey` is a `unique symbol`, so two copies of this package mint two
different brands: a contract marked against one does not type as marked in the
other. The **runtime** registry does not split that way — it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/requirements")`, so every
copy reads and writes one `WeakMap`.

That asymmetry is deliberate. A module-private map would make a second copy
silent: `isAuthenticated` `undefined` everywhere, no scheme dependency
declared, and a marked route **served open**. Sharing the registry makes the two halves fail
together, and the type half fails loudly. `@btravstack/http-server` peers on this
package so an application holds a single copy in the first place.

`PRINCIPAL` is also never exported as a value, and must stay that way: a
nameable brand could be written onto a contract node by hand without the
matching `WeakMap` entry — typed as protected, unmarked at runtime, so no
authenticator is demanded and a handler reads a principal nothing injected.
See
[Peer dependencies](/explanation/peer-dependencies).
:::

## See also

- [Protect a procedure](/how-to/protect-a-procedure) — mark, authenticate,
  compose.
- [`@btravstack/http-server`](/reference/http-server) — `defineHttp`, `HttpAuthenticator`,
  `Unauthenticated`, and what a marked leaf's handler receives.
- [Order API (HTTP)](/examples/order-api) — a contract with one marked
  fragment, one public one, and a procedure that overrides its group's
  default.
