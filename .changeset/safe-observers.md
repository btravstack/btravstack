---
"@btravstack/core": patch
---

Isolate observer startup and settlement failures so telemetry preserves operation outcomes and later observers still settle. Qualify synchronous operation throws as defects. Broken settlement-shaping hooks fall back to normal settlements.
