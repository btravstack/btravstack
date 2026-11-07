---
"@btravstack/temporal-worker": minor
---

Add `withTemporalDiagnostics` to scope diagnostic configuration without eagerly
creating Temporal's native Runtime. Startup refusals and defects before the first
native connection can exit naturally; configuration is restored on every outcome
without closing an existing or still-active Runtime. The eager installer remains
available for applications that explicitly own its lifetime.
