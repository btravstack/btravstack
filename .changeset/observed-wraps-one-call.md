---
"@btravstack/core": minor
---

`observed(observers, operation, call, settled?)` joins `observe`: the same
start-then-settle around one `AsyncResult`-returning call, settling `ok` or
`error` from the channel it came back on, so a starter's instrumentation is one
line per method. `@btravstack/cache`, `@btravstack/mailer` and
`@btravstack/storage` report through it; what they report is unchanged.
