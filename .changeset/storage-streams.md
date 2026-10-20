---
"@btravstack/storage": minor
---

**Breaking: `StorageService` gains three required members, `putStream`, `putStreamIfAbsent` and `getStream`.** An adapter or test double implementing it directly must add them; one composed through `storage({ adapter })` from `memoryStorage()` or `s3Storage()` needs no change.

Stream objects through the process in bounded memory. `putStream` and `putStreamIfAbsent` write a `ReadableStream<Uint8Array>` (on S3, a multipart upload aborted on any failure, so no partial object is ever visible; the conditional variant sends `If-None-Match: *` on the publishing write), and `getStream` answers `{ stream, contentType, size }`, `size` being `undefined` when the store sends no length. A source that errors answers the new `StreamInterrupted`, carrying its error as `cause`; `StorageUnavailable.operation` gains `"putStream"`, `"putStreamIfAbsent"` and `"getStream"`, and the operations are observed as `put_stream`, `put_stream_if_absent` and `get_stream`, an interrupted source settling `ok` with `result: "interrupted"`.
