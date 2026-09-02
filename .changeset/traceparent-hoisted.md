---
"@btravstack/core": minor
"@btravstack/http-server": patch
"@btravstack/amqp-worker": patch
---

`traceIdOfTraceparent` is `@btravstack/core`'s, beside `releasedBy`.

The parser was duplicated verbatim in `@btravstack/http-server` and
`@btravstack/amqp-worker` — the same shape issue #24 hoisted `releasedBy` for.
Every transport carrying an inbound trace needs the same answer, and two copies
of a parser is two places for the all-zero rule to be forgotten.

It takes the trace-id field and nothing else: the parent's **span id is
dropped**, because `UnitMeta.traceId` is a correlation id rather than a span
context, and an all-zero trace id is the specification's own "invalid" and is
refused like a malformed header. A runtime pairs it with the rule its own
headers need — adopt only a non-blank inbound id, since `traceId` defaults to
`meta.id` when it is nullish and `""` is not.

No behaviour changes in either runtime; the export is new.
