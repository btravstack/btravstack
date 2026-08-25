---
"@btravstack/observability": minor
"@btravstack/http-server": minor
"@btravstack/amqp-worker": minor
---

The traces-and-metrics half of observability ships, as the deferred design
prescribed. `@btravstack/observability/otel` — with `@opentelemetry/api` and
`@opentelemetry/sdk-node` as optional peers, the `pino` protocol — exports
`Tracer` and `Meter` ports over a `NodeSDK` held as a resourceful provider
whose `release` flushes (a lost flush is a `teardownError` and exit `2`,
never silence), and `UnitSpanModule`, a `StartOptions.unit` module opening a
span per kernel unit with the ambient record's `unitId`/`traceId`/`tenantId`
as attributes. Configuration is the SDK's own `OTEL_*` conventions — no
config slice. Inbound, `@btravstack/http-server` and `@btravstack/amqp-worker` honour a
W3C `traceparent` (trace-id field only, outranking `x-request-id` and
`messageId`); `@btravstack/temporal-worker` deliberately keeps the workflow id as
its correlation.
