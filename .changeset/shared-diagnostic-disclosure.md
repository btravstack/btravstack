---
"@btravstack/core": minor
"@btravstack/observability": minor
"@btravstack/temporal-worker": minor
---

Add a shared, explicit diagnostic disclosure policy for logs, starter-owned traces and Temporal SDK/runtime logging. Production policies keep static diagnostic identities and allowlisted bounded fields while excluding free-text failures, stacks, nested causes and arbitrary payloads. Add a pre-start Temporal installer that forwards native Core logs through the same boundary, and an explicit sensitive-debug policy without changing Result outcomes or default sink behavior.
