---
"@btravstack/storage": minor
---

`Storage.presignedUpload(key, { ttlMs, contentType, contentLength })` mints a
time-limited URL a client writes straight at the store, so an upload's bytes
never transit the application process. The content type and the length are part
of the signature, so the URL grants exactly one write, of exactly that size, of
exactly that type — `contentLength` is required because it is the only ceiling a
presigned PUT can express. The memory adapter refuses it, as it already refused
`presignedUrl`, rather than minting a URL that would pass locally and fail in the
deployment.
