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

- **`auth<P>()`** (`auth.ts`) — `(): { readonly authenticated: <T extends
object>(node: T) => Authenticated<T, P> }`. Mints the combinator for one
  contract's principal type `P`. Call it once per contract, destructure
  `authenticated`, and apply it to a record of procedures (protects every
  procedure beneath it) or to a single procedure (protects itself).
- **`Authenticated<T, P>`** — `T & { readonly [PrincipalKey]: P }`. The typed
  shape a marked node carries — `T`'s own keys plus one phantom key that
  exists only for the type checker.
- **`PrincipalKey`** — `typeof PRINCIPAL`, the marker's key. Exported so a
  consumer's own mapped type can `Exclude<keyof C, PrincipalKey>` and land on
  exactly the contract's own keys.
- **`PrincipalOf<T>`** — `T extends { readonly [PrincipalKey]: infer P } ? P :
never`. Recovers the principal type a node was marked with, `never` when it
  carries no marker.
- **`isAuthenticated(node: object): boolean`** — whether this exact node was
  marked. Ancestry (a marked parent implying a marked child) is the caller's
  to carry; the package tracks nodes, not trees.

## Three load-bearing properties

**Zero dependencies and zero peers.** Nothing here imports oRPC, `di`, `core`
or `unthrown`. That is what lets a client take a contract without pulling in
the server that implements it, and what would let an AMQP or Temporal
contract reuse the exact same `auth()` combinator — the marker has no
opinion about which transport reads it.

**The combinator returns the node unchanged and sets no property on it.**
`authenticated(node)` returns the same reference (`=== `) with nothing added
to it — `PRINCIPAL` is `declare`d, never assigned, so it exists only in the
type system. There is no key for oRPC's `implement()` to walk as a
procedure, and nothing for its builders to strip. The marker lives in a
module-private `WeakSet`, keyed by identity.

**Applied after a builder chain is finished, never inside one.** `authenticated`
wraps a finished contract node — the last call in a chain, or a whole record
of finished nodes — never a step in the middle of building one. No oRPC
builder has to know the marker exists or preserve it through its own chain.

## Specs

`vitest run --coverage`, 100% lines/functions, 4 tests in one file,
`auth.spec.ts`: marking returns the same reference and a readable marker, no
enumerable key is added, an unmarked node reads as unmarked, and two
contracts' markers stay independent. `test-fixtures.ts` provides the
`authenticated` combinator and a one-key `fragment`, both as lazy fixtures.

## Deferred, deliberately

Nothing consumes this yet. A later package reads `PrincipalKey` /
`PrincipalOf` off a marked contract to type a handler's context with the
principal, and a starter maps a missing or invalid principal to a transport
error — neither exists here, and this package does not anticipate their
shape.
