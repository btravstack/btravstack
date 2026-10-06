---
"@btravstack/observability": patch
---

An operation observed inside a unit — a cache read, a stored object, a sent mail, a query — now opens its span as the CHILD of the unit's `UnitSpanModule` span, and stamps `btravstack.unit_id`, `btravstack.trace_id` and `btravstack.tenant_id` from the ambient record. They used to be root spans with no correlation, so nothing joined them to the unit or to its log lines.
