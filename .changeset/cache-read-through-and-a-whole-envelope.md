---
"@btravstack/cache": minor
"@btravstack/mailer": minor
---

`Cache.getOrSet` decides the read-through policy once, and `Mail` carries the
whole envelope.

**`getOrSet(key, loader, { ttlMs })`** is the read-through every caller was
writing by hand, with the two degradations settled in the port: an unavailable
cache runs the loader, and a failed write is not the caller's error. That is why
`CacheUnavailable` is absent from its error channel — what is left is the
loader's own `E`. `examples/order-api`'s customers controller collapses from a
`get`, two `recoverErrCases`, a `flatMap`, a `flatTap` and a cast to one call.

It is **derived, not implemented**: `cache()` builds it over `get` and `set`, so
an adapter still writes three methods and the two calls it makes are the
observed ones. `CacheService` is now `CacheBackendService & { getOrSet }` — an
adapter targets `CacheBackendService` (the new name for what it always
implemented), and `Cache` carries the wider one. There is no stampede
protection: a hundred concurrent misses run a hundred loaders, and locking or
serve-stale is a named option the day one is asked for.

**`Mail`** gains `cc`, `bcc`, `attachments` and `headers`. A transactional
invoice mail is roughly the second one a service sends, and a port that could
not carry it would be bypassed rather than extended — losing the recorder, the
instrumentation and the health story at once. An attachment is
`{ filename, content: Uint8Array | string, contentType? }`: bytes or a string,
never a path or a stream, since a caller holding a file can read it and an
adapter should not have to own a lifetime. The SMTP adapter forwards all four,
and the instrumented recipient count now includes `cc` and `bcc`. Templating and
i18n stay out — `text` and `html` are strings, and what rendered them is a
library the application chose.

Closes #201, closes #202.
