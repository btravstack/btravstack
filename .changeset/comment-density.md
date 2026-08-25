---
"@btravstack/contract": patch
"@btravstack/di": patch
"@btravstack/config": patch
"@btravstack/core": patch
"@btravstack/testing": patch
"@btravstack/observability": patch
"@btravstack/cache": patch
"@btravstack/mailer": patch
"@btravstack/storage": patch
"@btravstack/http-server": patch
"@btravstack/temporal-worker": patch
"@btravstack/amqp-worker": patch
---

A comment earns its line, or it goes

A quarter of the TypeScript in this repository was comment, and one line in ten
an inline essay — so a reader looking for the code had to skim past the reasons
for it. `CLAUDE.md`'s "comment density: sparse" bullet now carries a test: a
comment earns its line only if it guards a specific line against a plausible
"simplification", states a symbol's contract as TSDoc, is a directive with a
reason, or is a `GIVEN`/`WHEN`/`THEN` marker.

No API changes. What consumers see is the TSDoc these packages ship in their
declarations: shorter, and stating each symbol's contract rather than the
history behind it, which lives in the repository and on the documentation site.
