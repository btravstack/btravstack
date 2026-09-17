---
"@btravstack/contract": minor
---

**New: `keyset(request)`, the keyset pagination an adapter would otherwise
hand-roll.** It answers one object carrying both halves of a page — `take` (the
page plus the one extra row that proves there is another, without a second
count query), `backward`, `cursor`, and a `page(rows, cursorOf, item?)` that
folds what the store answered:

```ts
const keys = keyset(request);
const listed = keys.page(store.seek(keys), (row) => String(row.id));
```

**The two halves ride one object because they have to agree.** A store queried
for `limit` and folded as though it had been queried for `limit + 1` reports
the last page as having a next one, forever — and there is now no way to spell
that. The same object also settles which side an over-fetched row proves:
paging forward it means there is a page after, paging backward it means there
is one before, and getting that backwards is what the two hand-rolled copies in
this repository disagreed about.

**It does not run the query**, and must not grow the ability to. The seek is
the one thing this tier cannot express — every store spells it differently —
and the moment this package knows how to issue one it has taken a persistence
opinion the tier exists to refuse. What it owns is the arithmetic around that
call, which is identical everywhere and is where the off-by-ones live: the
over-fetch, the trim, the backward walk handed back in reading order, and the
rule that each side's cursor comes from a row actually on the page, so an empty
page carries neither.

`page`'s third argument is there because **the row a store seeks by is rarely
the thing a port hands back**: an adapter pages on a surrogate key and answers
domain entities, so the cursor and the item come off the same row by two
routes. It defaults to the row itself.

Nothing is removed: `page(items, { previous, next })` still takes the cursors
directly, for a store that reports both itself.
