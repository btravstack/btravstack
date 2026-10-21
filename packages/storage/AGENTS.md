# AGENTS.md — @btravstack/storage

The application-service port for object storage: a `Storage` an application
depends on, adapters that provide the `StorageBackend` behind it, and one
composition function that binds them together, with every operation reported
to `Observers`.

The third of issue #62's three ports, on `@btravstack/cache`'s shape exactly —
read that package's `AGENTS.md` for the two-port rationale; only what differs
is written out here.

## Public surface

The exports are `src/index.ts` and `src/s3.ts` (`@btravstack/storage/s3`), each
with its TSDoc; what the observers make of an operation is `src/instrument.ts`,
and `docs/reference/storage.md` is the reader's page.

## Decisions

- **A missing object settles `ok` with `result: "not_found"`, and writes no
  line.** Asking for something that is not there is an ordinary answer — a
  caller checking whether a document exists yet meets it on the happy path —
  and a dashboard that treats it as a fault teaches its readers to ignore the
  fault line. `StorageUnavailable` is what pages somebody. Invalid options and checksum
  mismatches also settle `error`, without recording their inputs.
- **`putIfAbsent` is the store's own conditional write, and `ObjectExists`
  settles `ok` with `result: "exists"`.** The S3 adapter sends
  `If-None-Match: *` and reads HTTP 412 as the held key; the status code, not
  the error name, is the test, since S3-compatible stores differ on the name.
  Losing the race is the answer the caller asked for, so it writes no fault
  line. Invalid options are refused before writing; checksum refusals become
  `ChecksumMismatch`. Other failures are `StorageUnavailable` with
  `operation: "putIfAbsent"`. RustFS proves a second write is refused and
  a race has one winner.
- **`PresignNotSupported` shares the result and NOT the words.** It is the
  same class — a "no" the caller can act on, not an outage — so both settle
  `result: "not_found"`. But its `reason` attribute says `"this store cannot
  mint a url"` where a missing object's says `"the object was not there"`,
  because the object may be sitting exactly where it was put, and an operator
  reading the latter would go hunting for nothing. The `result` separates
  ordinary from faulty; the `reason` has to say what actually happened.
- **`presignedUpload` signs the content type and the content length, and
  `contentLength` is therefore required.** Both are in the signature, so a
  client sending different ones is refused by the store. The URL can be reused
  until expiry to replace the object with different bytes of the same size and
  type; neither signed header binds the bytes. That is the only ceiling a
  presigned PUT can express: S3 has no "at most n bytes" for this shape, so an
  optional length would quietly allow an unbounded single write. Replays can
  still multiply the total bytes transferred before expiry.
  Setting both on the command is NOT enough: the presigner signs
  `content-length` by default but lists `content-type` among the headers it
  leaves unsigned, so `content-type` is named in `getSignedUrl`'s
  `signableHeaders`. Without it the URL's `X-Amz-SignedHeaders` was
  `content-length;host`, and a same-length write under another type was taken
  with `200` (#369) — the size test alone could not have shown it, since the
  length was always signed. A presigned POST policy WOULD
  express a range, at the cost of a third optional peer and a form-encoded
  return shape; it is not here because nothing has asked for a range.
- **`head` reports; accepting an upload still belongs to the application.**
  A signed URL proves neither that a write happened nor which bytes remain at
  its key. `head` answers size, type and the stored SHA-256 (hex; S3 reports
  base64, converted once in the adapter) without reading the object, and a
  `presignedUpload` with `sha256` signs `x-amz-checksum-sha256` as an
  unhoisted header — hoisted into the query it was unsigned and a client could
  swap it (the s3 spec proves the swap is refused). An application that cares about the contents reads a unique staging
  key with `get`, validates those bytes, writes them to a final key that was
  never presigned, and only then records acceptance. A replay can replace the
  staging object until expiry, but cannot replace the accepted final object
  through that URL. `docs/how-to/upload-a-file.md` shows the boundary.
- **`copy` is S3 `CopyObject` with `MetadataDirective: REPLACE`**, so the
  content type is the caller's, and a missing source is `ObjectNotFound` naming
  the source (settled `ok`/`not_found` like `get` and `head`). `kmsKeyId` on
  writes and copy sends `ServerSideEncryption: aws:kms` + `SSEKMSKeyId`; RustFS
  has no KMS, so the spec captures the commands at the SDK middleware.
- **Write digests and copy algorithms are different options.** Writes send
  `ChecksumSHA256`, with malformed hex refused before the request and
  `BadDigest` / `InvalidDigest` modeled as `ChecksumMismatch`. Copy sends
  `ChecksumAlgorithm: SHA256`. Neither accepts the other's checksum option.
  Memory verifies before mutating its map and preserves its always-computed
  full-object `head` checksum; S3 excludes multipart composite checksums.
- **Metadata is an owned object description, never an observation attribute.**
  Keys are lowercase ASCII HTTP tokens; uppercase is refused, so case collisions
  cannot silently overwrite a value. The caller owns S3's 2 KB UTF-8 key/value
  budget. `head` answers an empty map by default and a snapshot otherwise;
  copy replaces metadata with the destination map, empty when omitted.
- **Presigned KMS headers stay signed and unhoisted**, like the checksum header.
  Both encryption headers are mandatory. RustFS proves that changing or dropping
  either breaks the signature; SDK command assertions prove what key and mode
  are requested. Neither proves encryption, since RustFS has no KMS.
- **A streamed write is a multipart upload that publishes nothing until it
  ends.** `putStream` reads 8 MiB parts and sends one at a time; a stream that
  ends within the first part is one `PutObject`. Any failure before
  `CompleteMultipartUpload` (the source's error as `StreamInterrupted`, a
  `sha256` mismatch, the store) aborts the upload and cancels the source with
  the failure as its reason, so no partial object is ever visible. An abort the
  store also refuses leaves parts that are no object, for the bucket's
  incomplete-upload lifecycle rule. Hand-rolled over the client's own
  commands rather than `@aws-sdk/lib-storage`'s `Upload`: a third optional peer
  for one loop, whose conditional write and abort are what this port must state.
- **A part handed to a recursing `flatMap` lives until the recursion ends.**
  `AsyncResult.flatMap` awaits its callback's result inside a frame that holds
  the input, so reading and sending each part are steps of their own and the
  recursion continues from the `boolean` that says whether the stream ended.
  Threading the part through it held every part to the last one, the whole
  object live at the end. The 256 MiB specs measure live memory, a full
  collection before each sample, so garbage the collector has not reached
  cannot pass for a leak, and a leak cannot hide behind a collection that
  happened to run.
- **`sha256` on a stream is the adapter's check, not the store's.** S3 keeps
  only a composite checksum for a multipart object, so the digest is computed
  and compared before completion; `head` answers no `sha256` for a streamed
  object, one part or many, so the answer does not depend on its size. It is
  taken over each part's `Buffer.concat` copy, never the chunks as read: the
  copy is what is sent, so a producer rewriting a chunk it already enqueued
  meets `ChecksumMismatch` rather than a digest of bytes the store never got.
- **`getStream`'s `size` is `undefined` when the store sends no length.**
  `head` keeps `size: number` and its `0` for the same case, since changing
  it would change a published type.
- **`putStreamIfAbsent` sends `If-None-Match: *` on the publishing write**,
  `PutObject` or `CompleteMultipartUpload`, so the key is refused only after
  the bytes were sent, and the refused upload is aborted. RustFS proves the
  refusal, the abort and a race with one winner.
- **`StreamInterrupted` settles `ok` with `result: "interrupted"`.** The source
  is the caller's: a client hanging up, or the caller's own check refusing the
  bytes by erroring its stream, is an answer it gives itself. Its `cause` is
  the stream's error, untouched, so that check gets its own refusal back.
- **`getStream`'s span ends when the stream is answered**, not when it is read:
  observing the transfer would mean wrapping every chunk, and the store's own
  failure mid-read reaches the reader as the stream's error.
- **Streamed calls have a socket pool of their own, and a full one refuses.**
  `s3Storage()` builds two clients, each with its own keep-alive agent:
  `getStream`, `putStream` and `putStreamIfAbsent` use one
  (`STORAGE_S3_STREAM_MAX_SOCKETS`), every other call the other
  (`STORAGE_S3_MAX_SOCKETS`), both 50 by default, the SDK's own size. Before
  that, one shared pool of 50 let 50 slow readers stall every `head`, `put` and
  health check in the process. A streamed call holds a slot from the call until
  its body closes (`close` on the SDK's Node body: read to its end, cancelled,
  broken off) or its write settles, counted in the adapter, so the agent never
  queues a stream. One more answers `StreamPoolFull` at once, rather than
  queueing: a queued stream waits for a reader elsewhere, which nothing in the
  process bounds, so the service could not shed load. It settles `ok` with
  `result: "saturated"`, a rate to alert on rather than a fault line per
  refusal. The buffered pool still queues, as the SDK does: its calls are
  short. RustFS proves a `head` and a `put` complete while every stream socket
  is held unread, which a shared pool of the same size does not.
- **The agents are instances, never agent options.** Given options, the SDK
  sends every body of 2 MiB or more (`Expect: 100-continue`: each 8 MiB part,
  a large `put`) on a fresh unpooled connection, which no `maxSockets` bounds
  and which keeps the request, and the part it carries, reachable until that
  connection has closed. A 32 MiB `putStream` opened connections through five
  agents; it now uses the pool's one, which the s3 spec counts. It counts
  agents, not connections, since a store may close a keep-alive socket and a
  reconnect through the pool is not a request outside it.
- **Every pool default is the SDK's own**, stated rather than inherited, and
  `requestTimeoutMs` sets `throwOnRequestTimeout`: a bound that only logs a
  warning is not one.
- **The stream pool's timeouts are its own, and default to the shared ones**
  (#646). A short call should fail fast on a stalled store; a stream is paced
  by the client at the other end, and a slow reader legitimately leaves the
  store's socket idle, so one value forced a service to pick which of the two
  to break. Each `stream*TimeoutMs` field reads `undefined` when unset and the
  composition takes the shared value then: `Config` has no field whose default
  is another field's. All three exist because the handler distinguishes them.
  Under 6 s the handler arms the socket timeout at once and it bounds a body
  read; from 6 s it arms it 3 s into the attempt and only while unanswered, so
  it never cuts a paused read. A listener that never answers proves a `head`
  closed after 200 ms while a stream waits out its 1000 ms.
- **The memory adapter refuses to presign** rather than minting a `file://`
  URL. A fake URL is the worst kind of double: it passes locally and fails in
  the deployment for a reason no test could have shown. The arm exists in the
  port precisely so an adapter that cannot do this can say so.

`presignedUrl`'s missing `ObjectNotFound` arm, the application deciding what the
adapter signs, idempotent `delete`, the
`application/octet-stream` default, path-style addressing and the private client
port are the TSDoc and comments of `src/storage.ts` and `src/s3.ts`.

## Deliberately not here

- **No multipart form parsing** anywhere in the family. A presigned write keeps
  the bytes out of the process and stays the default; the streamed writes
  arrived with a consumer that must see the bytes as they pass (a document
  store sealing them), and take the body as a stream.
- **No listing, and no multipart upload of the caller's own.** Listing is a
  real S3 feature with no consumer here; adding it speculatively is what issue
  #62 says not to do. Parts exist only inside `putStream`. `copy` and `head`
  arrived with a consumer: a document store that moves a verified upload to its
  final key, with no bytes through the process.
- **No tags.** User metadata is atomic object description only.
- **No bucket management.** Creating one is deployment, not runtime — the
  test infrastructure creates the gate's bucket, and a deployment creates its
  own.

## Testing

RustFS (`internal/test-infra`) is pre-1.0 and its `latest` tag moves, so the
exact rc is pinned — and every operation the port needs was measured against
that image _before_ the port was written.

**Memory is sampled after two full collections, not one.** V8 frees an
`ArrayBuffer`'s backing store on a background thread after the collection that
found it dead (`--concurrent-array-buffer-sweeping`), and
`process.memoryUsage().arrayBuffers` counts it until then. On a loaded runner
one `gc()` left up to 80 MiB of dead 8 MiB parts counted, which is what made
the 256 MiB bounds flaky; a second collection first finishes the previous
sweep.

Two failure fixtures, because one cannot reach both arms: an endpoint that is
**not listening** (`http://127.0.0.1:1`) reaches `put`/`get`/`delete`, and a
client whose **credentials will not resolve** reaches `presignedUrl` and
`presignedUpload`, which never leave the process and so cannot fail on an
unreachable endpoint.

The upload arm is proved end to end rather than by inspecting a URL: a plain
`fetch` `PUT`s at the minted URL carrying no credentials, and the object is
then read back through the port. A replay test uses the same URL twice and
reads the replacement. Two siblings prove the binding, one per signed header:
four bytes at a URL signed for one, and the right number of bytes under
another content type — each `403`, and nothing stored.

Observation: see the root `AGENTS.md`, **Observability is a set port, never a flag**.
