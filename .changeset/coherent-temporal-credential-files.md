---
"@btravstack/temporal-worker": patch
"@btravstack/temporal-client": patch
---

Read projected Temporal credential files from a coherent immutable generation.
Resolve and verify file targets around each batch, retry bounded generation
changes, and retain all stable validation failures. A Kubernetes Secret swap can
no longer mix an old certificate with a new private key or turn old-generation
garbage collection into a false reload refusal.
