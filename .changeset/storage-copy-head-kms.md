---
"@btravstack/storage": minor
---

Add `StorageService.copy` (server-side `CopyObject`, content type replaced) and `head` (size, content type and a hex `sha256` when the store holds one), an optional `kmsKeyId` on `put`, `putIfAbsent` and `copy` (SSE-KMS), and an optional `sha256` on `presignedUpload` that signs `x-amz-checksum-sha256` so the store refuses other bytes. `StorageUnavailable.operation` gains `"copy"` and `"head"`; the instrumented composition reports them as `copy` and `head`, counting a missing object as `not_found`.
