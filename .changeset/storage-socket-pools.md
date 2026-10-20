---
"@btravstack/storage": minor
---

Give the S3 adapter's streamed transfers a socket pool of their own. `s3Storage()` now builds two clients: `getStream`, `putStream` and `putStreamIfAbsent` use one, every other call the other, so streams held open by slow readers no longer stall `head`, `put` or the health check. Both pools and the SDK's timeouts are configurable, each option pinning its variable, and every default is the AWS SDK's own: `maxSockets` (`STORAGE_S3_MAX_SOCKETS`, 50), `streamMaxSockets` (`STORAGE_S3_STREAM_MAX_SOCKETS`, 50), `connectionTimeoutMs`, `socketTimeoutMs` and `requestTimeoutMs` (`STORAGE_S3_CONNECTION_TIMEOUT_MS`, `STORAGE_S3_SOCKET_TIMEOUT_MS`, `STORAGE_S3_REQUEST_TIMEOUT_MS`, 0 for none, each per attempt; a request timeout fails the attempt instead of logging a warning).

Every request now goes over its pool's keep-alive sockets: a body of 2 MiB or more, each 8 MiB part of a streamed write included, no longer opens a connection of its own outside any pool.

A streamed call past the stream pool's size is refused at once with the new `StreamPoolFull` (`operation`, `key`, `maxSockets`), observed as `result: "saturated"`; a refused write's stream is cancelled. `getStream`, `putStream` and `putStreamIfAbsent` gain that arm, so an exhaustive match over their errors must handle it, and more than 50 concurrent streams per process, which used to queue, are now refused unless `streamMaxSockets` is raised. `s3StorageBackend(client, bucket, streams?)` takes the stream pool as an optional third argument; without it the streamed calls share `client`, unbounded, as before.
