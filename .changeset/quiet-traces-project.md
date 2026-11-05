---
"@btravstack/observability": patch
---

Apply the configured diagnostic policy to ambient unit, trace and tenant correlation before custom sinks, JSON/Pino output and starter-owned spans receive it. The production policy retains opaque UUIDs and nonzero W3C trace IDs, replaces unapproved required identifiers with a static marker and omits an unapproved optional tenant ID. Caller-supplied free text such as an HTTP request ID no longer bypasses the disclosure boundary; unconfigured and explicitly sensitive rendering retain their existing behavior.
