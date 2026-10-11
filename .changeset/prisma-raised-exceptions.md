---
"@btravstack/prisma": minor
---

`tryQuery` and `tenantPinned` take `raises`, a list of SQLSTATEs the
application raises on purpose — a trigger's `RAISE EXCEPTION … USING ERRCODE`
— and answer each listed code as a `RaisedException<S>` carrying `sqlState`,
the message, and the constraint and table where the database named them,
instead of a defect. Listing nothing changes nothing: the error channel stays
`SqlError`, so existing exhaustive matches compile unchanged. `qualify` takes
the same option; `Raised<S>` and `QualifyOptions<S>` are exported beside it.
