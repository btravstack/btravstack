---
"@btravstack/observability": patch
---

Accept `@opentelemetry/sdk-node` 0.301 beside 0.222. The 0.301 line takes
metric readers only as `metricReaders`, a list; `otel()` passes SDK options
through unchanged.
