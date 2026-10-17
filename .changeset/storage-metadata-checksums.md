---
"@btravstack/storage": minor
---

Add atomic user metadata to writes and copies, with owned snapshots from `head`.
Add verified SHA-256 write digests, server-computed SHA-256 copies, and per-object
SSE-KMS requirements on presigned uploads. Invalid digests/metadata keys return
`InvalidStorageOptions`; body mismatches return `ChecksumMismatch`. Callers must
handle the new Result cases, and custom adapters must return `head.metadata`.
`CopyOptions` is distinct from `WriteOptions` so copy never ignores a write digest.
