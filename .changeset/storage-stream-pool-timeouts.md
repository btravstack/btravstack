---
"@btravstack/storage": minor
---

Give the S3 adapter's stream pool timeouts of its own. `s3Storage()` takes `streamConnectionTimeoutMs`, `streamSocketTimeoutMs` and `streamRequestTimeoutMs`, each pinning its variable (`STORAGE_S3_STREAM_CONNECTION_TIMEOUT_MS`, `STORAGE_S3_STREAM_SOCKET_TIMEOUT_MS`, `STORAGE_S3_STREAM_REQUEST_TIMEOUT_MS`), and applies them to `getStream`, `putStream` and `putStreamIfAbsent` only. Unset, each falls back to its shared counterpart (`connectionTimeoutMs`, `socketTimeoutMs`, `requestTimeoutMs`), so nothing changes for a consumer that sets none. A service can now fail a stalled `head` or `get` within a short bound while a slow reader or a large part keeps a longer one.
