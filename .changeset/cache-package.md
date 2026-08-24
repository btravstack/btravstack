---
"@btravstack/cache": minor
---

A `Cache` port, an in-memory adapter and a Redis one, and one composition
function whose `instrumented` flag decides whether every call opens a span,
counts its outcome — telling a hit from a miss — and logs a failure.

Adapters provide a `CacheBackend`; `cache({ adapter })` provides `Cache` from
it, so instrumentation is a decision at the composition root and not a
decorator applied after the fact (di allows one provider per port per graph,
which is what makes a wrapper impossible). The flag is off by default, and a
graph that leaves it off installs no observability at all: `Logger`, `Tracer`
and `Meter` are `@btravstack/core`'s ports, so this package names them without
depending on an implementation. `redis` is the only optional peer, behind the
`@btravstack/cache/redis` subpath.
