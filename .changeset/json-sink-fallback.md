---
"@btravstack/observability": patch
---

`jsonSink`'s fallback for a line `JSON.stringify` refuses now keeps every field that renders — the unit's `unitId`, `traceId` and `tenantId` included — and names the ones it dropped in `unserialisable` (`["total"]` for a `BigInt` attribute), instead of writing only the time, level and message beside `cause: "[unserialisable]"` whatever the culprit was. The reference page now documents the line's field names.
