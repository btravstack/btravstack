---
"@btravstack/testing": minor
"@btravstack/temporal": minor
"@btravstack/http": minor
"@btravstack/amqp": minor
---

Multi-tenancy, as one optional hook per starter, and the harness primitive
that makes it testable.

`http()`, `amqp()` and `temporal()` — and the `HttpModule` / `AmqpModule` /
`TemporalModule` sugar over each — now take an optional **`tenantOf`**. It
reads a tenant off the transport's own input (the request, the delivery, the
activity invocation) and puts it on `UnitMeta.tenantId`, from where the kernel
puts it on the ambient unit record and an infrastructure adapter reads
`currentUnit()?.tenantId` per call. Nothing above the adapter changes: no
procedure, handler or activity takes a tenant, and no use case or entity
mentions one.

The starters map nothing beyond that. Refusing work that carries no tenant is
a decision about a status code, an ack/nack or an activity failure, and these
packages decline those. A blank or whitespace answer is refused the same way a
blank trace id already was.

`@btravstack/testing` gains **`unitFixture()`** / **`InUnit`**, and
`TestRuntime` gains **`inUnit(meta, work)`**: running a callback inside a real
kernel unit is what testing an ambient reader needs, and the kernel
deliberately exports no way to open one. The unit is the kernel's own, opened
through `RuntimeHost.run` exactly as a transport opens one.

Every one of these is additive — omit `tenantOf` and no unit carries a tenant,
which is what every version before this did.
