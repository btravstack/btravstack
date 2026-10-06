---
"@btravstack/observability": minor
---

**Breaking for dashboards: `btravstack.<component>.duration` is now recorded in seconds**, with unit `s` and the OpenTelemetry semantic conventions' bucket boundaries (`0.005` … `10`), instead of milliseconds on the SDK's default buckets. The metric names are unchanged.

Migration: divide any threshold or panel reading these histograms by 1000 (`> 250` ms becomes `> 0.25`). A Prometheus exporter now suffixes the series `_seconds` where it used to suffix `_milliseconds`, so queries naming the old series need renaming. The other deviations from semconv — span names, no `SpanKind`, the starters' own attribute names — are now stated on the observability reference page.
