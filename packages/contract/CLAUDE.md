# packages/contract

The contract package's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what
only matters when you are working under `packages/contract/`. Keep it in
sync with the code in the same commit, and with `README.md` — the package
ships no `docs-examples.test-d.ts`, so nothing else compiles these claims.

## What this is

**The contract tier: what a client and the server that implements it both
need, and no transport owns.** Two things live here today, admitted by one
rule (below): the `authenticated` marker, and the shape of a cursor page.

### The admission rule

A shape belongs in this package when **both ends of a contract need it and no
transport owns it**. A page passes: a client reads `hasNextPage` and hands
`nextCursor` back, a server builds one, and HTTP, AMQP and Temporal would each
describe the same thing. An error vocabulary does not: thesis #3 keeps triage
per contract, and each transport's destination is its own library's
(`errors.CONFLICT` is oRPC's constructor). A domain type does not either — it
is the application's.

The test is deliberately narrow, because the name promises a tier and the
package is what stops that promise from being a slogan. Filters and sorts are
the next candidates and are **not** here: nothing has written the same one
twice yet.

### The root is zero-dependency; schemas are behind `/zod`

The root imports nothing, not even `unthrown` — a client takes a contract
without taking a runtime. A **schema** needs a schema library, so the four-arm
page schema and the page input live behind `@btravstack/contract/zod`, with
`zod` as an **optional peer**: the subpath protocol `@btravstack/cache/redis`
and `@btravstack/observability/pino` already follow. A contract that only
marks its procedures installs nothing.

## The marker

A marker a contract puts on a node — a record of procedures or a single
procedure — to say "this requires an authenticated principal, satisfying one
of these requirements", readable by both the client that imports the contract
and the server that implements it. A requirement is OpenAPI's own shape: a
security scheme name and the scopes it must grant. Nothing here talks to
oRPC, HTTP, AMQP or Temporal; it is a plain object marker over `WeakMap`
identity, transport-agnostic by construction.

## Public surface

- **`authenticated(...requirements)(node)`** (`auth.ts`) — curried:
  `<const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> }>(...requirements: R) => <T extends object>(node: T) =>
Authenticated<T, R>`. Call it with one or more `Requirement`s to get back a
  function that marks a node with them, in the order given. Apply it to a
  record of procedures (the **default** for every procedure beneath it) or to
  a single procedure (which **replaces** that default for itself — nearest
  mark wins).
- **`Requirement`** — `Readonly<Record<string, readonly string[]>>`, e.g.
  `{ user: ["orders:export"] }`: one security scheme's name mapped to the
  scopes it must grant. It is the **carrier** — what a marked node holds and
  `isAuthenticated` reads back — so it says nothing about arity; `OneScheme<Q>`
  in `authenticated`'s own constraint is what refuses a second key where one
  is written. Exactly one scheme deliberately:
  AND-within-a-requirement is not modelled, because that would put a record
  rather than a single identity on the handler, and a handler wants to know
  which scheme authenticated the caller, not juggle several at once. **The
  constraint is not documentation, because the discrepancy silently WEAKENS
  the rule**: OpenAPI reads `{ user: [], mtls: [] }` as AND, and
  `@btravstack/http-server` walks the entries taking the first that satisfies, which
  is OR — so a requirement copied out of an OpenAPI document would have
  admitted a caller presenting either.
- **`OneScheme<Q>`** — `SeveralKeys<keyof Q> extends false ? Q : never`, over
  the standard distribute-then-compare-back union test; pinned by
  `auth.test-d.ts`. Exported so a consumer minting its own requirement-typed
  surface — `@btravstack/http-server`'s `HtmxGet`/`HtmxPost` is the first — can
  intersect it into that surface's own constraint rather than re-deriving the
  same refusal.
- **`Requirements`** — `readonly Requirement[]`. Several requirements on one
  mark are **ORed**, tried in declaration order: the first the caller
  satisfies wins.
- **`Authenticated<T, R>`** — `T & { readonly [PrincipalKey]: R }`. The typed
  shape a marked node carries — `T`'s own keys plus one phantom key, holding
  the exact `Requirements` it was marked with, that exists only for the type
  checker.
- **`PrincipalKey`** — `typeof PRINCIPAL`, the marker's key. Exported so a
  consumer's own mapped type can `Exclude<keyof C, PrincipalKey>` and land on
  exactly the contract's own keys.
- **`IsMarked<T>`** — `T extends { readonly [PrincipalKey]: Requirements } ?
true : false`. Whether this exact node carries the marker. A **yes/no**, not
  a type: a consumer reads it to decide whether to inject a principal, never
  to learn what one is.
- **`RequirementsOf<T>`** — `T extends { readonly [PrincipalKey]: infer R
extends Requirements } ? R : never`. What this exact node's mark requires, at
  the type level — `never` for an unmarked node.
- **`isAuthenticated(node: object): Requirements | undefined`** — what this
  exact node requires, or `undefined` when nobody marked it. `undefined`, not
  an empty array, so a caller cannot confuse "public" with "protected by
  nothing satisfiable". Ancestry (a marked parent implying a marked child) is
  the caller's to carry; the package tracks nodes, not trees.

### The page (`pagination.ts`, and `zod.ts` behind `/zod`)

- **`Page<T>`** — `{ items: readonly T[] }` intersected with each side's
  flag-and-cursor pair, so a `hasNextPage: false` page has no `nextCursor`
  field at all.
- **`page(items, { previous, next })`** — a `Page<T>` from its items and the
  cursor on each side, `null` where there is none. The flags are derived.
- **`PageRequest`** — `{ limit }` with `after` **or** `before`, never both.
- **`PageQuery`** — the flat `{ limit, after?, before? }` a schema validates
  to, before narrowing.
- **`pageRequest(query)`** — `PageQuery & filters` to `PageRequest & filters`.
  `before` wins if both are present, which `pageRequestOf` makes unreachable;
  the precedence exists so the function is total.
- **`pageOf(item)`** (`/zod`) — the four pages, as a union of four
  `strictObject`s.
- **`pageRequestOf(filters, limits?)`** (`/zod`) — the input schema: a
  bounded `limit` (default 20, ceiling 100, both overridable through
  `PageLimits`), the two optional cursors, a refusal of the pair, and this
  listing's own filters merged in. `filters` is required; `{}` is how a
  listing says it has none.

## The contract says which schemes; the application says what each one is

**The contract names no identity type at all.** A marked node names the
schemes a caller may present and the scopes each must grant, and stops there;
`@btravstack/http-server`'s `defineHttp({ authenticators })` is what says what each
scheme resolves to, server-side, and a handler minted from that call sees
those types. So nothing about the server's own view of a caller — roles, an
org tier, an internal id — reaches a client, and enriching it is never a
contract change and never a client-visible field.

There is therefore nothing here to keep minimal and nothing here to leak.
There is also no identity comparison left to make: declaring a scheme and
implementing it are the same act in `defineHttp`, so a scheme the contract
names with no authenticator behind it is di's own unmet need on
`HttpAuthenticator:<scheme>`, not a gate either package writes.

## Three load-bearing properties

**Zero dependencies and zero peers.** Nothing here imports oRPC, `di`, `core`
or `unthrown`. That is what lets a client take a contract without pulling in
the server that implements it, and what would let an AMQP or Temporal
contract reuse the exact same `authenticated` marker — the marker has no
opinion about which transport reads it.

**The combinator returns the node unchanged and sets no property on it.**
`authenticated(...requirements)(node)` returns the same reference (`===`)
with nothing added to it — `PRINCIPAL` is `declare`d, never assigned, so it
exists only in the type system. There is no key for oRPC's `implement()` to
walk as a procedure, and nothing for its builders to strip. The marker lives
in a `WeakMap`, keyed by identity, mapping each node to the `Requirements` it
was marked with.

Identity is exactly why a consumer takes this package as a **peer** rather
than an ordinary dependency — `@btravstack/http-server` and
`examples/order-api-contract` both do. Two copies in one install would each
hold their own registry, a contract marked by one would read unmarked to the
other, `OrpcRouter` would declare no scheme dependency at all and the
protected route would be served **open**. So the registry is copy-proof: it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/requirements")`, and
every copy shares the one `WeakMap`. The key changed from the earlier
`.../marked` — it named a `WeakSet` of marked nodes; naming it `requirements`
prevents a stale copy expecting a `WeakSet` from calling `.has()` on the new
`WeakMap` and getting an accidentally-correct `true` back, which would have
masked the version mismatch instead of failing closed. A stray second copy
now degrades to a compile error — the two copies' `PRINCIPAL` symbols are
different `unique symbol`s — rather than to a silently unprotected route.

`PRINCIPAL` is `declare`d and **never exported as a value**, and must stay
that way — but be precise about what that buys. It stops the mark being
applied by accident or written literally; it does **not** make it unforgeable.
`Authenticated<T, R>` is exported, because `@btravstack/http-server`'s `Inherit`
needs it, so a deliberate
`node as unknown as Authenticated<typeof node, [{ user: [] }]>` types as
protected while the registry stays empty: the type says marked so `HttpModule`
demands an authenticator, `hasMarked` answers `false` at runtime so `routerOf`
installs no middleware, and the leaf serves unauthenticated. It
takes a double cast to reach, which is the whole of the protection. Exporting
the symbol would remove even that, which is why the TS2527 wart a consumer
hits when re-exporting an inferred controller type is worth paying —
`@btravstack/http-server` pays it by handing back **one** nameable object,
`Http<A>`, from `defineHttp`: held whole rather than destructured, the
inferred type never mentions this symbol and an application writes no
annotation at all.

**Applied after a builder chain is finished, never inside one.** `authenticated`
wraps a finished contract node — the last call in a chain, or a whole record
of finished nodes — never a step in the middle of building one. No oRPC
builder has to know the marker exists or preserve it through its own chain.

## Specs

`vitest run --coverage`, 100% lines/functions, 13 tests in two files.

`pagination.spec.ts` covers the page: the flags are derived from the cursors,
every page `page()` builds parses against `pageOf` (all four), a cursor on a
closed side is refused rather than stripped, the schema refuses both cursors
at once, `PageLimits` applies and bounds, a filter survives the schema and the
narrowing, an absent cursor is dropped rather than carried as `undefined`, and
`before` wins when both somehow arrive. `pagination.test-d.ts` pins the
no-drift claim and the unrepresentable states.

`auth.spec.ts` covers the marker: marking returns the same reference and readable requirements,
several requirements survive in the order given, no enumerable key is added,
an unmarked node reads as `undefined`, and the mark lands in the `globalThis`
registry a second copy would read. `test-fixtures.ts` provides a one-key
`fragment` as a lazy fixture. `auth.test-d.ts` pins the type side: the phantom
key excludes cleanly out of `keyof`, `IsMarked` is **exactly** `true` / `false` (asserted both
directions — a `boolean` result would satisfy assignability to either), a
marked node still satisfies the plain shape, a plain one does not satisfy the
marked shape, and `RequirementsOf` reads the exact requirements back for a
marked node and is `never` for an unmarked one.

## Marking is opt-in, and an unmarked node is public

`authenticated(...requirements)(node)` marks; `isAuthenticated(node)` reads the
node's **own** mark and answers `undefined` when it has none. There is no
default requirement anywhere, so **forgetting the marker fails nothing** — the
one property worth stating out loud, because it is the failure mode a reader
should expect to own.

**Unmarked is not the same as public.** A mark applies to a node and everything
below it: `@btravstack/http-server`'s `routerOf` walks the tree carrying the
nearest ancestor's requirements down (`declared ?? inherited`), so an unmarked
procedure under a marked namespace is protected by that namespace. Unmarked
means _no requirement of its own_; public means no marked ancestor either.

That is also why there is no `public(node)` escape: deleting a node's entry
would not clear an ancestor's, so an opt-out would have to be an explicit mark
of its own — a third state this package does not have and does not need until
somebody has a marked ancestor they want a hole in.

Deny-by-default is deliberately not taken: this package has **zero
dependencies** and knows nothing about who is calling, so a default requirement
would be a deployment's decision made for every consumer of the contract,
including the client that only ever calls. Where a deny-by-default posture is
wanted it belongs at the composition root that owns the authenticators.

## The page, and what it deliberately is not

`Page<T>` pairs each side's flag with the cursor that continues it, so
"there is more, and nothing to follow it with" is unrepresentable rather than
merely unexpected. `page(items, cursors)` derives the flags from the cursors,
because a side with no cursor is a side a caller cannot reach. `PageRequest`
makes `after` and `before` a union, so a page runs in one direction by
construction; `pageRequest(query)` is the crossing from the flat shape a
schema validates into that union, carrying a listing's own filters through.

`pageOf(item)` is the four pages that exist, as four closed objects in a
union — a union rather than an intersection because `allOf` of closed objects
validates nothing in JSON Schema, and the emitted OpenAPI document is an
interop surface. `pageRequestOf(filters, limits?)` is the input, refusing both
cursors at once in the **schema**, so the refusal is published rather than
left to a handler.

**The two halves cannot drift.** `pagination.test-d.ts` pins that what
`pageOf` parses to is a `Page`, and `pagination.spec.ts` closes the loop the
type test cannot: every page `page()` builds parses against `pageOf`, where
`readonly` no longer exists. That pair is the reason this shape is worth a
package rather than a doc.

**A cursor is an opaque `string`, not a branded type.** A brand was considered
and declined: it would have to be minted by the schema to survive parsing, and
zod's own brand or a `transform` degrades what `toJSONSchema` emits — trading
the interop target for a guarantee the server already gives by refusing a
cursor it cannot read. Offsets, page numbers and totals are not offered
either; a cursor page is one opinion, and a second one is a second way.

**No `MalformedCursor` here.** The framework norms the shape; each
application keeps its own error vocabulary, which is thesis #3 at this tier.
`examples/order-application` declares that error, and its listing's `Page`
comes from here.

## Deferred, deliberately

**A transport other than HTTP reading the marker.** `@btravstack/http-server` is the
only consumer today. Nothing here is HTTP-shaped — an AMQP or Temporal
contract could mark a node with the same `authenticated` and its starter read
`isAuthenticated` — but neither does, and this package does not anticipate
what a broker's or a workflow's authenticator would look like.
