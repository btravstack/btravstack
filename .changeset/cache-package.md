---
"@btravstack/cache": minor
---

A `Cache` port, an in-memory adapter and a Redis one, and an opt-in
instrumented composition that opens a span, counts the outcome — telling a hit
from a miss — and logs a failure for every call.

Adapters provide a `CacheBackend`; a composition provides `Cache` from it, so
instrumentation is a choice at the composition root rather than a flag, and
`cache()` installs no observability at all. `redis`, `@btravstack/observability`
and `@opentelemetry/api` are optional peers behind the `/redis` and
`/instrumented` subpaths.
