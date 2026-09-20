# @btravstack/contract

> The contract tier: what a client and the server that implements it both
> need, and no transport owns. Declare **which security schemes** a procedure
> accepts and which scopes each must grant, and nothing about who the caller
> is; and describe **one page of a listing** once, as the type a port speaks
> and the schema a contract publishes. The root has zero dependencies — a
> client can take a contract without the server, and any transport's contract
> can use the same marker.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/contract)** ·
[API Reference](https://btravstack.github.io/btravstack/api/contract/)

```sh
pnpm add @btravstack/contract
```

Nothing to install beside it, unless you use the page **schemas** under
`@btravstack/contract/zod`, whose `zod` is an optional peer. **A package that
ships a marked contract takes this one as a `peerDependency`** rather than an
ordinary one — the marker is identity-based, so one copy per application is
the point; see [Why a peer](#the-marker-is-a-weakmap-not-a-property) below.
Node `>=22`.

## Usage

<!-- doctest: prelude
import { oc } from "@orpc/contract";
import { z } from "zod";
const order = z.object({ id: z.uuidv7() });
const place = oc.input(order).output(order);
const find = oc.input(order).output(order);
-->

```ts
import { authenticated } from "@btravstack/contract";

export const contract = {
  orders: authenticated({ user: [] })({
    place,
    find,
    // Overrides the group default for itself: a `user` token needs the scope,
    // or a `service` token needs nothing.
    export: authenticated(
      { user: ["orders:export"] },
      { service: [] },
    )(oc.output(z.object({ csv: z.string() }))),
  }),
  customers: { find },
};
```

`authenticated` is **curried**: it takes one or more OpenAPI security
requirements — a scheme name mapped to the scopes it must grant — and hands
back the function that marks a node. Several requirements are **ORed**, tried
in the order given. A marked record is the default for every procedure beneath
it; a marked procedure **replaces** that default for itself. Nearest mark
wins, which is OpenAPI's own rule. Apply it after a builder chain is finished,
never inside one.

**The contract says which schemes protect a route; the application's
`defineHttp({ authenticators })` says what each one resolves to.** No identity
type is named here, so nothing about the server's own view of a caller reaches
a client, and enriching it is never a contract change.

### The marker is a WeakMap, not a property

The marker is **identity-based** — a `WeakMap`, no property on the node — which
is why a package shipping a marked contract takes this one as a **peer**
dependency rather than an ordinary one: two copies would mean two registries,
and a contract marked by one reading unmarked to the other is a protected route
served open. The registry is copy-proof against that anyway (it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/requirements")`, so every
copy shares one `WeakMap`), so a stray second copy costs a compile error on the
mismatched marker symbol, not an open route.

`isAuthenticated(node)` reads back the `Requirements` a node was marked with,
or `undefined` when nobody marked it.

## Paging a listing

One page, described once: the type a port speaks and the schema the contract
publishes are the same shape, and a test pins that they cannot drift apart.

<!-- doctest: prelude
import { oc } from "@orpc/contract";
import { z } from "zod";
const orderView = z.object({ id: z.uuidv7(), quantity: z.number() });
-->

```ts
import { pageOf, pageRequestOf } from "@btravstack/contract/zod";

export const orders = oc.router({
  list: oc
    .input(pageRequestOf({ minQuantity: z.number().int().min(1).optional() }))
    .output(pageOf(orderView)),
});
```

A flag and its cursor are one fact. `hasNextPage: true` carries the
`nextCursor` that continues the listing, and `hasNextPage: false` has no such
field — so "there is more, and nothing to follow it with" is unrepresentable,
and a client that checked the flag holds the cursor with no null to widen it.
`after` and `before` are a union in the type and refused as a pair by the
schema: a page runs in one direction.

An adapter pages a listing with `keyset(request)`, which answers one object
holding both halves of a keyset page — `take` (the page plus the one extra row
that proves the next one), `backward`, `cursor`, and a `page` that folds what
the store answered:

<!-- doctest: prelude
declare const store: {
  seek: (keys: { take: number; backward: boolean; cursor: string | undefined }) =>
    readonly { readonly id: number }[];
};
declare const request: import("@btravstack/contract").PageRequest;
-->

```ts
import { keyset } from "@btravstack/contract";

const keys = keyset(request);
const listed = keys.page(store.seek(keys), (row) => String(row.id));
```

The over-fetch and the trim agree by construction, which is the whole reason
they are one object. `keyset` does not run the query — that is the one thing
this tier cannot express — and where a store reports both cursors itself,
`page(items, { previous, next })` takes them directly. A controller turns a
validated input into the port's `PageRequest` with `pageRequest(input)`.

### Sorting a listing

A listing declares its own sortable vocabulary, checked against the item it
already publishes, and a required default — an implicit one would be a
listing sorted by something nobody chose:

```ts
import { sortableBy } from "@btravstack/contract/zod";

export const sortedOrders = oc.router({
  list: oc
    .input(
      pageRequestOf(
        { minQuantity: z.number().int().min(1).optional() },
        {
          sortableBy: sortableBy(orderView, ["quantity"]),
          defaultSort: { field: "quantity", direction: "desc" },
        },
      ),
    )
    .output(pageOf(orderView)),
});
```

The cursor carries the sort **verbatim, not hashed** — `field:direction`,
`encodeURIComponent`d beside the sort value and the tiebreak — because the
vocabulary is already public in the emitted OpenAPI document. A cursor is
valid only for the sort it was issued under: sorted, `keyset(request)`
answers `SortedKeyset<F> | CursorRefused`, a union the adapter must branch on
rather than an unfiltered page served from the wrong side:

<!-- doctest: prelude
declare const sortedRequest: import("@btravstack/contract").PageRequest<"quantity">;
declare const sortedRows: readonly { readonly id: string; readonly quantity: number }[];
-->

```ts
import { keyset } from "@btravstack/contract";

const sortedKeys = keyset(sortedRequest);
const sortedListed = sortedKeys.resumable
  ? sortedKeys.page(sortedRows, (row) => [String(row.quantity), String(row.id)])
  : sortedKeys.reason; // "malformed" or "sort-mismatch"
```

`SortedKeyset<F>.page`'s `cursorOf` returns **both** values a sorted seek
needs — the sort key's and the tiebreak's — so a forgotten tiebreak is a
compile error rather than a keyset that silently skips rows that tie.

## License

[MIT](./LICENSE) © Benoit TRAVERS
