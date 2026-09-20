---
"@btravstack/contract": minor
---

**New: a listing may declare which of its keys are sortable.**
`sortableBy(item, keys)` checks the vocabulary against the item's own schema —
a name outside its shape, or a nullable or optional key, is a compile error
rather than a runtime surprise. `pageRequestOf(filters, { sortableBy,
defaultSort })` takes it beside a listing's filters; `defaultSort` is
**required** alongside `sortableBy`, because an implicit default is a listing
sorted by something nobody chose:

```ts
import { sortableBy } from "@btravstack/contract/zod";

const sorted = pageRequestOf(
  { minQuantity: z.number().int().min(1).optional() },
  {
    sortableBy: sortableBy(orderView, ["quantity"]),
    defaultSort: { field: "quantity", direction: "desc" },
  },
);
```

**`PageRequest` is now generic over its listing's sortable vocabulary.**
`PageRequest<F>` carries a required `sort: Sort<F>` when `F` is not `never`,
and no `sort` field at all when it is — a listing that names no vocabulary can
never carry one, and one that does always has one, `prefault`ed to
`defaultSort` when a caller names none.

**A sorted `keyset(request)` answers a union the caller must branch on.**
`SortedKeyset<F> | CursorRefused`, discriminated by `resumable`, in place of
the unsorted call's bare `Keyset`. The cursor a sorted listing mints carries
the sort it was issued under — `field:direction`, verbatim rather than
hashed, since the vocabulary is already public in the emitted document — so
one replayed under a different sort, or the same field in the other
direction, is **refused** rather than served from the wrong side:
`CursorRefused.reason` is `"malformed"` or `"sort-mismatch"`, told apart
because only the second is actionable. `SortedKeyset<F>.page`'s `cursorOf`
must now return both the sort value and the tiebreak, so a forgotten tiebreak
is a compile error rather than a keyset that silently skips tied rows.

Nothing about an unsorted listing changes: `pageRequestOf(filters)` and
`keyset(request)` with no `sort` still answer the plain `PageRequest` and
`Keyset` they always did.
