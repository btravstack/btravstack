---
"@btravstack/http-server": minor
---

Expose independent keepalive, keepalive buffer and socket inactivity budgets
with validated deployment configuration. Preserve request receive deadlines,
stream progress, cancellation and graceful shutdown. Share one response lifecycle
listener so streamed adapters can coexist with ordinary application close listeners
without exceeding the default listener budget.
