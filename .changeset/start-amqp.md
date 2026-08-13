---
"@btravstack/start-amqp": minor
---

The AMQP consumer runtime for `@btravstack/start`.

`amqpRuntime({ urls, contract, handlers, needs })` runs an `amqp-contract`
worker under the kernel's lifecycle: one unit per delivery, and a drain where
the kernel's `drainTimeoutMs` is the only deadline — the library is told to wait
forever and the kernel's signal is raced against it, so there is no second
timeout to keep in sync.

Add `messageUnits(host)` to the worker's middleware and every delivery becomes a
kernel unit with the application context injected. `amqp-contract` is not a peer
dependency — the middleware type is structural — and `Result` → ack / retry /
DLQ is deliberately not mapped here, because the handler's `RetryableError` /
`NonRetryableError` and the queue's own retry policy already decide it.
