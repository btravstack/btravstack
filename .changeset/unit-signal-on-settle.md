---
"@btravstack/core": patch
---

A unit's `AbortSignal` now aborts once the unit settles, with an `AbortError` reading "The unit has settled", so work a runtime left running past its unit is told to stop. Under `@btravstack/http-server` a client that disconnects aborts the handler's signal. The drain's accounting is unchanged: a settled unit is never counted `abandoned`.
