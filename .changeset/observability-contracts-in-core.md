---
"@btravstack/core": minor
"@btravstack/observability": minor
---

**Breaking.** `Logger`, `Tracer` and `Meter` — and `LoggerService`, `Level`,
`LEVELS` and `Attributes` with them — are now declared by `@btravstack/core`
and imported from there. `@btravstack/observability` keeps every
implementation (`createLogger`, `jsonSink`, `pinoSink`, `observability()`,
`otel()`, `UnitSpanModule`) and no longer exports the ports; there is no
re-export, so one contract has exactly one import path.

A contract that other framework packages depend on has to be reachable
without installing an implementation, and the kernel is the package all of
them already peer on. The tracing pair is also declared **without naming
OpenTelemetry** now — each is a narrowing that a real OTel `Span`, `Tracer`
and `Meter` satisfies structurally, so the vendor's types stop at the
`@btravstack/observability/otel` subpath and a port no longer points at an
implementation.

To migrate: change the import, not the code.

```diff
-import { Logger } from "@btravstack/observability";
-import { Meter, Tracer } from "@btravstack/observability/otel";
+import { Logger, Meter, Tracer } from "@btravstack/core";
 import { observability } from "@btravstack/observability";
 import { otel } from "@btravstack/observability/otel";
```
