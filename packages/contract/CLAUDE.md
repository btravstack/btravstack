# packages/contract

The contract package's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what
only matters when you are working under `packages/contract/`. Keep it in
sync with the code in the same commit, and with `README.md` — the package
ships no `docs-examples.test-d.ts`, so nothing else compiles these claims.

## What this is

A marker a contract puts on a node — a record of procedures or a single
procedure — to say "this requires an authenticated principal", readable by
both the client that imports the contract and the server that implements it.
Nothing here talks to oRPC, HTTP, AMQP or Temporal; it is a plain object
marker over `WeakSet` identity, transport-agnostic by construction.

## Public surface

- **`authenticated(node)`** (`auth.ts`) — `<T extends object>(node: T) =>
Authenticated<T>`. One export, no factory and no type parameter: apply it to
  a record of procedures (protects every procedure beneath it) or to a single
  procedure (protects itself).
- **`Authenticated<T>`** — `T & { readonly [PrincipalKey]: true }`. The typed
  shape a marked node carries — `T`'s own keys plus one phantom key that
  exists only for the type checker.
- **`PrincipalKey`** — `typeof PRINCIPAL`, the marker's key. Exported so a
  consumer's own mapped type can `Exclude<keyof C, PrincipalKey>` and land on
  exactly the contract's own keys.
- **`IsMarked<T>`** — `T extends { readonly [PrincipalKey]: true } ? true :
false`. Whether this exact node carries the marker. A **yes/no**, not a type:
  a consumer reads it to decide whether to inject a principal, never to learn
  what one is.
- **`isAuthenticated(node: object): boolean`** — whether this exact node was
  marked. Ancestry (a marked parent implying a marked child) is the caller's
  to carry; the package tracks nodes, not trees.

## The contract says whether; the application says what

**The contract names no identity type at all.** A marked node says a caller
must be authenticated and stops there; `@btravstack/http`'s
`httpAuth<Identity>()` is what says what a principal is, server-side, and a
handler minted from it sees that type. So nothing about the server's own view
of a caller — roles, an org tier, an internal id — reaches a client, and
enriching it is never a contract change and never a client-visible field.

There is therefore nothing here to keep minimal and nothing here to leak. The
gate that used to compare a contract's principal against an authenticator's
now compares the **router's** identity against the authenticator's, inside
`@btravstack/http`, where both come from the same `httpAuth` call.

## Three load-bearing properties

**Zero dependencies and zero peers.** Nothing here imports oRPC, `di`, `core`
or `unthrown`. That is what lets a client take a contract without pulling in
the server that implements it, and what would let an AMQP or Temporal
contract reuse the exact same `authenticated` marker — the marker has no
opinion about which transport reads it.

**The combinator returns the node unchanged and sets no property on it.**
`authenticated(node)` returns the same reference (`=== `) with nothing added
to it — `PRINCIPAL` is `declare`d, never assigned, so it exists only in the
type system. There is no key for oRPC's `implement()` to walk as a
procedure, and nothing for its builders to strip. The marker lives in a
`WeakSet`, keyed by identity.

Identity is exactly why a consumer takes this package as a **peer** rather
than an ordinary dependency — `@btravstack/http` and
`examples/order-api-contract` both do. Two copies in one install would each
hold their own registry, a contract marked by one would read unmarked to the
other, `HttpRouter` would declare no authenticator need and the protected
route would be served **open**. So the registry is copy-proof: it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/marked")`, and every copy
shares the one `WeakSet`. A stray second copy then degrades to a compile
error — the two copies' `PRINCIPAL` symbols are different `unique symbol`s —
rather than to a silently unprotected route.

`PRINCIPAL` is `declare`d and **never exported as a value**, and must stay
that way. A nameable brand could be hand-written onto a contract node without
the corresponding `WeakSet` entry: typed as protected, unmarked at runtime —
so no authenticator is demanded and a handler reads a principal nothing ever
injected. The TS2527 wart a consumer hits when re-exporting an inferred
controller type is the price, and the aliases `@btravstack/http` exports
(`HttpControllerOf<Identity>` and friends) are how it is paid.

**Applied after a builder chain is finished, never inside one.** `authenticated`
wraps a finished contract node — the last call in a chain, or a whole record
of finished nodes — never a step in the middle of building one. No oRPC
builder has to know the marker exists or preserve it through its own chain.

## Specs

`vitest run --coverage`, 100% lines/functions, 5 tests in one file,
`auth.spec.ts`: marking returns the same reference and a readable marker, no
enumerable key is added, an unmarked node reads as unmarked, the mark lands in
the `globalThis` registry a second copy would read, and two contracts' markers
stay independent. `test-fixtures.ts` provides a one-key `fragment` as a lazy
fixture. `auth.test-d.ts` pins the type side: the phantom key excludes cleanly
out of `keyof`, `IsMarked` is **exactly** `true` / `false` (asserted both
directions — a `boolean` result would satisfy assignability to either), a
marked node still satisfies the plain shape, and a plain one does not satisfy
the marked shape.

## Deferred, deliberately

**A transport other than HTTP reading the marker.** `@btravstack/http` is the
only consumer today. Nothing here is HTTP-shaped — an AMQP or Temporal
contract could mark a node with the same `authenticated` and its starter read
`isAuthenticated` — but neither does, and this package does not anticipate
what a broker's or a workflow's authenticator would look like.
