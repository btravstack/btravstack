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
kernel unit with the application context injected. `@amqp-contract/worker` and
`@opentelemetry/api` are peer dependencies — install them alongside this
package; `@amqp-contract/contract` stays a devDependency only, used to type
this package's own tests and never appearing in the published type surface,
because the middleware type is declared structurally rather than imported.

`Result` → ack / retry / DLQ is a three-way split, not a single mapping: a
modeled `RetryableError` / `NonRetryableError` is routed by `amqp-contract`'s
own dispatch against the queue's retry policy, and a `Defect` is a third
channel — dead-lettered on its first attempt, never retried, unless the
handler recovers it into a `RetryableError` itself.
