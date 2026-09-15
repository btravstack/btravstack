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

## The marker

A marker a contract puts on a node — a record of procedures or a single
procedure — to say "this requires an authenticated principal, satisfying one
of these requirements", readable by both the client that imports the contract
and the server that implements it. A requirement is OpenAPI's own shape: a
security scheme name and the scopes it must grant. Nothing here talks to
oRPC, HTTP, AMQP or Temporal; it is a plain object marker over `WeakMap`
identity, transport-agnostic by construction.

## Public surface

`src/index.ts` and `src/zod.ts` (`/zod`), each with its TSDoc;
`docs/reference/contract.md`'s **Exports** tables carry every signature, why a
`Requirement` names exactly one scheme, and why `isAuthenticated` answers
`undefined` rather than an empty array.

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

## Load-bearing properties

The first three — zero dependencies, a combinator that returns the node
unchanged with its mark in a `WeakMap` keyed by identity, and marking only a
finished builder chain — are `docs/reference/contract.md`'s **Three
load-bearing properties**. What follows is what that identity costs.

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

## Specs

`pagination.spec.ts` covers the page: the flags are derived from the cursors,
every page `page()` builds parses against `pageOf` (all four), a cursor on a
closed side is refused rather than stripped, the schema refuses both cursors
at once, `PageLimits` applies and bounds, a filter survives the schema and the
narrowing, an absent cursor is dropped rather than carried as `undefined`, and
`before` wins when both somehow arrive. A `defaultLimit` above the listing's
own ceiling is refused, which is why the limit uses `prefault` rather than
`default` — a default is handed back unparsed. `pagination.test-d.ts` pins
what `pageOf` parses to, the unrepresentable states, and the refusal of a
filter named `limit`, `after` or `before`.

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

Why the two halves cannot drift, why a cursor is not a branded type, and why
`MalformedCursor` stays the application's are `docs/reference/contract.md`'s
**Paging a listing** and `src/zod.ts`'s TSDoc.

## Deferred, deliberately

**A transport other than HTTP reading the marker.** `@btravstack/http-server` is the
only consumer today. Nothing here is HTTP-shaped — an AMQP or Temporal
contract could mark a node with the same `authenticated` and its starter read
`isAuthenticated` — but neither does, and this package does not anticipate
what a broker's or a workflow's authenticator would look like.
