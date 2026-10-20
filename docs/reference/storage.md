---
title: "@btravstack/storage"
description: The complete surface of @btravstack/storage — the Storage and StorageBackend ports, StoredObject, StreamedObject, ObjectHead, WriteOptions, CopyOptions and the modeled storage failures, the memory and S3 adapters, storage(), the Observers seam it reports through, and the STORAGE_S3_* variables and socket pools.
---

<!-- doctest: group=order-temporal-worker -->
<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { Logger } from "@btravstack/core";
import {
  memoryStorage,
  memoryStorageProvider,
  Storage,
  storage,
  type StorageService,
} from "@btravstack/storage";
import { s3Storage } from "@btravstack/storage/s3";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { overridden } from "@btravstack/testing";
import { P, type AsyncResult } from "unthrown";

declare const RealApp: Module<Storage, never, never>;
-->

# @btravstack/storage

> **Reference.** A complete, structured description of `@btravstack/storage`:
> the `Storage` port an application depends on, the modeled failures, the in-memory and S3-compatible adapters, and the one
> composition function that binds them together.

## The port

```ts
export const documents = Provider(
  Port("ReferenceDocuments")<{
    readonly save: (key: string, pdf: Uint8Array) => AsyncResult<void, never>;
    readonly link: (key: string) => AsyncResult<string | undefined, never>;
  }>,
)({
  inject: { store: Storage },
  sync: ({ store }) => ({
    save: (key, pdf) =>
      store
        .put(key, pdf, { contentType: "application/pdf" })
        .recoverErrCases((matcher) =>
          matcher.with(P.tag("StorageUnavailable"), P.tag("InvalidStorageOptions"), P.tag("ChecksumMismatch"), () => undefined),
        ),
    link: (key) =>
      store
        .presignedUrl(key, { ttlMs: 60_000 })
        .recoverErrCases((matcher) =>
          matcher
            .with(P.tag("StorageUnavailable"), () => undefined)
            .with(P.tag("PresignNotSupported"), () => undefined),
        ),
  }),
});
```

| Method                                                                            | Answers                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `put(key, bytes, options: WriteOptions)`                                          | `AsyncResult<void, InvalidStorageOptions \| ChecksumMismatch \| StorageUnavailable>`                                                        |
| `putIfAbsent(key, bytes, options: WriteOptions)`                                  | `AsyncResult<void, ObjectExists \| InvalidStorageOptions \| ChecksumMismatch \| StorageUnavailable>`                                        |
| `putStream(key, stream, options: WriteOptions)`                                   | `AsyncResult<void, InvalidStorageOptions \| ChecksumMismatch \| StreamInterrupted \| StreamPoolFull \| StorageUnavailable>`                 |
| `putStreamIfAbsent(key, stream, options: WriteOptions)`                           | `AsyncResult<void, ObjectExists \| InvalidStorageOptions \| ChecksumMismatch \| StreamInterrupted \| StreamPoolFull \| StorageUnavailable>` |
| `get(key)`                                                                        | `AsyncResult<StoredObject, ObjectNotFound \| StorageUnavailable>`                                                                           |
| `getStream(key)`                                                                  | `AsyncResult<StreamedObject, ObjectNotFound \| StreamPoolFull \| StorageUnavailable>`                                                       |
| `copy(from, to, options: CopyOptions)`                                            | `AsyncResult<void, ObjectNotFound \| InvalidStorageOptions \| StorageUnavailable>`                                                          |
| `head(key)`                                                                       | `AsyncResult<ObjectHead, ObjectNotFound \| StorageUnavailable>`                                                                             |
| `delete(key)`                                                                     | `AsyncResult<void, StorageUnavailable>`                                                                                                     |
| `presignedUrl(key, { ttlMs })`                                                    | `AsyncResult<string, PresignNotSupported \| StorageUnavailable>`                                                                            |
| `presignedUpload(key, { ttlMs, contentType, contentLength, sha256?, kmsKeyId? })` | `AsyncResult<string, PresignNotSupported \| InvalidStorageOptions \| StorageUnavailable>`                                                   |

`WriteOptions` requires `contentType` and accepts `kmsKeyId`, `sha256` and
`metadata`. `CopyOptions` requires `contentType` and accepts `kmsKeyId`,
`metadata` and `checksum: "sha256"`. A write verifies a supplied digest;
a copy asks the store to compute one. Passing a write digest to `copy`, or a
copy algorithm to a write, is a type error even when options are held in a variable.

**Write checksums are verified before publication.** `sha256` is lowercase,
64-character hexadecimal. Malformed input returns `InvalidStorageOptions`
with `reason: "invalid_sha256"` before a request or signature is attempted.
S3 receives the base64 digest as `ChecksumSHA256`; its `BadDigest` and
`InvalidDigest` refusals become `ChecksumMismatch`. Memory verifies the bytes
before changing its map. A mismatch cannot create an object or replace a
successful object, including through `putIfAbsent`.

**Metadata belongs to the same atomic write as the bytes.** `metadata` is a
`Readonly<Record<string, string>>` of user metadata, without the `x-amz-meta-`
prefix. Keys must be nonempty lowercase ASCII HTTP tokens (letters `a-z`,
digits, or `!#$%&'*+-.^_` plus the backtick and `|~`). Keys are not normalized:
uppercase, whitespace and non-ASCII keys return `InvalidStorageOptions` with
`reason: "invalid_metadata_key"`. This refuses case collisions rather than
silently choosing one value. The caller respects S3's **2 KB limit, measured
as the sum of UTF-8 bytes of keys and values**. Metadata is not copied into
observations or log attributes. Memory snapshots the map on write and `head`
returns an owned snapshot, so mutating either map cannot change stored metadata.

```ts
export const publishArtifact = (
  store: StorageService,
  key: string,
  bytes: Uint8Array,
  sha256: string,
) => store.putIfAbsent(key, bytes, {
  contentType: "application/pdf",
  sha256,
  metadata: { producer: "report-builder", revision: "v1" },
});

export const promoteArtifact = (store: StorageService) =>
  store.copy("staging/report.pdf", "published/report.pdf", {
    contentType: "application/pdf",
    checksum: "sha256",
    metadata: { producer: "publisher" },
  }).flatMap(() => store.head("published/report.pdf"));
```

**`putIfAbsent` is the first-writer-wins write.** It stores the object only if
no object holds the key, atomically in the store: the S3 adapter sends
`If-None-Match: *` and maps the store's `412 Precondition Failed` to
`ObjectExists`, the memory adapter checks and sets in one step. Two concurrent
calls on one key answer exactly one `Ok` and one `ObjectExists`, and the first
bytes stay. Use it to publish an artifact once per request at a key derived
from the request id, without a database to decide the winner.

**`copy` moves no bytes through the process.** The S3 adapter sends
`CopyObject` with `MetadataDirective: REPLACE`, so the copy takes the
`contentType` and metadata you give rather than the source's. Omitted metadata
means an empty destination description. `checksum: "sha256"` sends
`ChecksumAlgorithm: SHA256` so S3 computes the full-object digest server side;
without it, S3 retains its own default checksum behavior. A missing source answers
`ObjectNotFound` naming the source key; an existing destination is overwritten,
and neither the source's tags nor its annotations are carried over
(`TaggingDirective: REPLACE`, `AnnotationDirective: EXCLUDE`).

**`kmsKeyId` selects SSE-KMS.** On `put`, `putIfAbsent`, the streamed writes, `copy` and `presignedUpload`, the S3
adapter sends `ServerSideEncryption: aws:kms` and `SSEKMSKeyId`; absent, no
encryption header is sent and the bucket's default applies. The memory adapter
accepts and ignores it. The gate's RustFS has no KMS, so the s3 spec asserts
the sent commands and mandatory signed headers rather than the stored encryption.
A presigned client must send both `x-amz-server-side-encryption: aws:kms` and
`x-amz-server-side-encryption-aws-kms-key-id: <exact kmsKeyId>`. Both headers
are signed and unhoisted: omitting or changing either invalidates the signature.
RustFS proves those signature refusals, not KMS encryption.

**`head` answers what the store knows without reading the object:** `size`,
`contentType`, `metadata` (empty when none was written) and optional `sha256`. S3 reports the checksum base64-encoded
(`ChecksumSHA256`, requested with `ChecksumMode: ENABLED`); the adapter returns
it as **lowercase hex**, and omits a multipart object's composite checksum,
which is not a digest of the bytes. Requesting the checksum of an SSE-KMS
object needs `kms:GenerateDataKey` and `kms:Decrypt` on its key, in the identity
policy and the key policy, besides `s3:GetObject`. Like `get`, a
missing key is `ok`/`not_found` in the signals. `sha256` is absent when the object was written without
a SHA-256 checksum (`put`, `putIfAbsent` or `presignedUpload` with `sha256`,
or `copy` with `checksum: "sha256"` requests one). A plain `put` retains the
SDK/store default checksum behavior. The memory adapter always computes it.

`ttlMs` is **required on both presign arms** — there is no default, because a
link's lifetime is a security decision and a framework guessing at it is a
framework guessing at your threat model. The S3 adapter rounds **up** to whole
seconds (`expiresIn` is seconds), so `1_500` is a two-second URL.

SigV4's ceiling is seven days, and it is the **signer** that enforces it: a
longer `ttlMs` is rejected locally, before any request reaches the store, and
arrives as a `StorageUnavailable` like any other failure to produce a URL.

**Bytes, or a stream when the object must not sit in memory.** `put` and `get`
hold a document whole — an invoice, a confirmation, an export — because
`Uint8Array` is what every adapter and caller already has. `putStream`,
`putStreamIfAbsent` and `getStream` move a large object through the process
in bounded memory, over web `ReadableStream<Uint8Array>`:

```ts
export const archive = (
  store: StorageService,
  key: string,
  body: ReadableStream<Uint8Array>,
  sha256: string,
) => store.putStreamIfAbsent(key, body, { contentType: "application/zip", sha256 });

export const served = (store: StorageService, key: string) =>
  store.getStream(key).map(
    ({ stream, contentType, size }) =>
      new Response(stream, {
        headers: {
          "content-type": contentType,
          ...(size === undefined ? {} : { "content-length": String(size) }),
        },
      }),
  );
```

- **No partial object is ever visible.** The S3 adapter writes a stream that
  ends within one 8 MiB part with a single `PutObject`, and a longer one as a
  multipart upload, one part in flight at a time. The object appears only when
  `CompleteMultipartUpload` succeeds, after the stream has ended. A chunk
  larger than a part is cut across parts. S3 allows 10,000 parts, so a
  streamed object tops out near 78 GiB: a longer stream is refused by the
  store, and arrives as `StorageUnavailable`, which no retry will cure. Bound
  what you accept well below it. A failure
  before that (the stream's own error, a `sha256` the bytes do not match, the
  store) aborts the upload and cancels the stream with the failure as its
  reason. Parts left behind when the store also refuses the abort are never
  an object; a bucket lifecycle rule for incomplete multipart uploads reaps
  them.
- **`StreamInterrupted` is the source's failure, not the store's.** It carries
  the stream's error as `cause`, so a caller that errors its own stream (a
  byte count that does not add up, a client that hangs up) gets that error
  back. Nothing was written.
- **`sha256` is verified by the adapter**, over each part's own copy, the
  bytes actually sent, and compared before the object is completed: S3 keeps only a composite checksum
  for a multipart object, so the store keeps no digest and `head` answers no
  `sha256` for a streamed object.
- **`putStreamIfAbsent` is the store's conditional write too.** It sends
  `If-None-Match: *` on the write that publishes the object, `PutObject` or
  `CompleteMultipartUpload`, so a held key is refused only once the stream has
  been sent, and the refused upload is aborted. AWS documents the condition on
  `CompleteMultipartUpload`, and the gate's RustFS proves it: a second write is
  refused and a race has one winner.
- **`getStream` answers once the store has begun sending.** `size` is the
  object's length, or `undefined` when the store sent none (a length is not
  invented), and `contentType` falls back to `application/octet-stream`.
  `head` keeps its `size: number`, answering `0` for a store that sends no
  length.
  The stream holds the store's connection until it is read to its end or
  cancelled, and a read the store breaks off errors it. Its span ends when the
  stream is answered, not when it is read.
- **The streamed calls have a socket pool of their own** on S3, and one call
  more than it holds answers `StreamPoolFull` at once, before anything is
  sent; a write's stream is cancelled with it. See
  [`s3Storage()`](#s3storage).
- The memory adapter reads a stream whole, as a `Map` holds objects whole.

**Keys are yours**, tenant included: `orders/{tenantId}/{orderId}/confirmation.json`
is what the Temporal example composes, by hand, because a store is an
application service and the framework has no concept of a tenant to put in a
slot.

## Modeled failures

| Error                   | Means                             | What a caller does                                     |
| ----------------------- | --------------------------------- | ------------------------------------------------------ |
| `InvalidStorageOptions` | malformed digest or metadata key  | corrects the options before retrying                   |
| `ChecksumMismatch`      | the digest did not match the body | supplies the correct digest or bytes                   |
| `ObjectExists`          | the key is already held           | treats the write as already done, or picks another key |
| `ObjectNotFound`        | the key is not there              | gives up, or writes it                                 |
| `StreamInterrupted`     | the source stream errored         | reads its own `cause`; nothing was written             |
| `StreamPoolFull`        | every stream socket was held      | sheds the transfer (`503`), retries later              |
| `StorageUnavailable`    | the store could not answer        | retries, degrades, or fails the request                |
| `PresignNotSupported`   | this adapter cannot mint a URL    | serves the bytes itself, or composes another adapter   |

Collapsing them would cost the distinction that matters: a caller retries an
outage and does not retry an absence.

**`delete` is idempotent** — deleting a key nobody stored is `Ok`, which is
S3's own behaviour rather than a fiction layered over it.

**`presignedUpload` is how bytes get in.** It signs the key, the content type
and the content length. The URL can be used repeatedly until expiry to replace
the object at that key with different bytes of the signed size and type. Those
headers do not prove the contents. `contentLength` is required: it is the only
ceiling a presigned PUT can express, and an optional one would allow an
unbounded single write. Replays can still multiply the total bytes transferred.
With the optional `sha256` (lowercase hex, 64 characters), the checksum is
signed too: the client must send `x-amz-checksum-sha256` (base64 of the digest),
the store refuses a body that does not hash to it, a client swapping the header
for the digest of its own bytes breaks the signature, and the digest is kept for
`head`. The S3 adapter keeps that header out of the query string, where it would
be unsigned. The gate's RustFS enforces both refusals.
The S3 adapter names `content-type` in the signature explicitly,
because the AWS presigner leaves it unsigned by default even when the command
sets it — an adapter of your own over that SDK must do the same, or the type
is advisory. The application still decides who may write what and for how long;
the adapter only computes the signature over that decision. An application that
needs to accept verified contents must validate a staging object and write
the accepted bytes under a key the URL cannot target. See
[Upload a file](/how-to/upload-a-file).

**`presignedUrl` has no `ObjectNotFound` arm.** Presigning is a signature
computation and asks the store nothing, so a URL for an absent key is minted
happily and `404`s when it is followed. Checking would cost a HEAD request per
call, bought for something the caller usually does not want. Both halves were
measured against RustFS before the port was written. A caller that must not
hand out a dead link reads first: `examples/order-amqp-worker`'s notifier
`get`s an invoice before presigning it into a withdrawal mail, retries an
`ObjectNotFound` while the invoice may still be on its way, and folds one past
the store's retention into a mail without a link.

## Adapters

### `memoryStorage()`

A `Map` in the process, and an **honest refusal to presign**:

```ts
export const withMemory = overridden(RealApp, [memoryStorageProvider()]);
```

`presignedUrl` answers `PresignNotSupported` rather than minting a `file://`
or `data:` URL. A fake URL is the worst kind of test double — one that passes
locally and fails in the deployment for a reason the test could never have
shown — and the arm exists in the port precisely so an adapter that cannot do
this can say so.

### `s3Storage()`

Two clients, built with the scope and destroyed with it, against any
S3-compatible store: AWS, RustFS, MinIO, R2, B2. Each has a socket pool of its
own: `getStream`, `putStream` and `putStreamIfAbsent` use one, every other
call the other.

```ts
export const Streaming = storage({ adapter: s3Storage({ streamMaxSockets: 20 }) });
```

| Variable                           | Option                | Required | Default     |
| ---------------------------------- | --------------------- | -------- | ----------- |
| `STORAGE_S3_ENDPOINT`              |                       | yes      | none        |
| `STORAGE_S3_BUCKET`                |                       | yes      | none        |
| `STORAGE_S3_ACCESS_KEY_ID`         |                       | yes      | none        |
| `STORAGE_S3_SECRET_ACCESS_KEY`     |                       | yes      | none        |
| `STORAGE_S3_REGION`                |                       | no       | `us-east-1` |
| `STORAGE_S3_MAX_SOCKETS`           | `maxSockets`          | no       | `50`        |
| `STORAGE_S3_STREAM_MAX_SOCKETS`    | `streamMaxSockets`    | no       | `50`        |
| `STORAGE_S3_CONNECTION_TIMEOUT_MS` | `connectionTimeoutMs` | no       | `0`, none   |
| `STORAGE_S3_SOCKET_TIMEOUT_MS`     | `socketTimeoutMs`     | no       | `0`, none   |
| `STORAGE_S3_REQUEST_TIMEOUT_MS`    | `requestTimeoutMs`    | no       | `0`, none   |

An option pins its variable. **Every default is the AWS SDK's own**: 50
keep-alive sockets per pool, and no timeout. Both timeouts and sizes apply to
each pool.

- **`maxSockets`** sockets serve every call but the streamed ones. A call
  finding them all busy waits for one, as the SDK always did.
- **`streamMaxSockets`** sockets serve the streamed calls, and bound them: each
  holds one from the call until its stream closes (read to its end, cancelled,
  broken off) or its write settles, and one more answers `StreamPoolFull` at
  once rather than waiting behind readers nothing in the process bounds. A slow
  download therefore never takes a socket a short call needs. How to size it,
  and the ingress limits it does not replace, are in
  [Stream a file through the process](/how-to/stream-a-file#_4-size-the-stream-pool).
- **`connectionTimeoutMs`** bounds how long an attempt waits for a socket, a
  free one from the pool or a new connection.
- **`socketTimeoutMs`** is the SDK's idle-socket timeout.
- **`requestTimeoutMs`** bounds an attempt until the store starts answering,
  its request body included; past it the attempt fails, and the call as
  `StorageUnavailable`, where the SDK on its own only logs a warning. It never
  cuts a response being read.

**The timeouts are per attempt.** The SDK retries a timed-out attempt, three
attempts by default, so a call can take about three times a timeout before it
answers.

The endpoint is **required rather than defaulted to AWS**: the stores this
port exists for all have one, and a default pointing at Amazon would be a
surprising bill rather than a convenience.

**Path-style addressing is on and not configurable** — every self-hosted store
requires it and AWS accepts it, so it is a value that never changes. A bucket
whose name is a valid AWS hostname is the one case that would want otherwise,
and that is a knob to add when somebody needs it.

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are **optional**
peers, reached only through the `@btravstack/storage/s3` subpath.

## `storage({ adapter })`

```ts
export const DocumentsApp = Module("ReferenceDocumentsApp")({
  imports: [storage({ adapter: s3Storage() }), observability(), otel()],
  provides: [documents],
  exports: [Storage, Logger],
});
```

| Signal    | Name                                                                                                                                                                         | Attributes                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| span      | `storage.put` / `.put_if_absent` / `.put_stream` / `.put_stream_if_absent` / `.get` / `.get_stream` / `.copy` / `.head` / `.delete` / `.presigned_url` / `.presigned_upload` | `btravstack.storage.key`; error status on a failure                                                                                                                                            |
| counter   | `btravstack.storage.operations`                                                                                                                                              | `{ operation, outcome, result }` — `outcome` is `ok` or `error`; `result` is `ok`, `exists`, `not_found`, `interrupted`, `saturated` or `error`; all but `ok` and `error` carry their `reason` |
| histogram | `btravstack.storage.duration`                                                                                                                                                | the same as the counter                                                                                                                                                                        |
| log       | `"storage.<operation> failed"` at `error`, for unavailable stores, invalid options or checksum mismatches                                                                    | `operation`, the key and `result`, with the failure as the cause                                                                                                                               |

**A missing object settles `ok`, counted apart by `result: "not_found"`, and
writes no line.** Asking for something that is not there is an ordinary answer
— a caller checking whether a document exists yet meets it on the happy path —
and a dashboard that treats it as a fault teaches its readers to ignore the
fault line. `StorageUnavailable` is what pages somebody, and settles `error`. Invalid options and checksum mismatches also settle
`error`, with safe errors that contain neither body, digest nor metadata.

**A presign refusal shares that result and not its words.** It is the same
class of answer, so both carry `result: "not_found"` — but its `reason` says
`"this store cannot mint a url"` where a missing object's says `"the object
was not there"`, because the object may be sitting exactly where it was put,
and an operator reading the latter would go hunting for nothing.

**A held key settles `ok` with `result: "exists"`** and its own `reason`
(`"an object already held the key"`), for the same reason: losing a first-writer
race is the answer the caller asked for, not an outage.

**A failed source stream settles `ok` with `result: "interrupted"`** and
`reason: "the source stream failed"`. A client hanging up or a caller's own
check refusing the bytes is the caller's answer to give, not the store's fault.

**A stream refused by a full pool settles `ok` with `result: "saturated"`**
and `reason: "every stream socket was held"`. Shedding the transfer is what the
pool's bound asked for, so it is a rate on the counter to alert on, not a fault
line per refusal.

**Observation is a set port, not a flag.** Every call is handed to whatever
contributed to `Observers`, and this module contributes a no-op member of its
own — so a graph composing no observability owes nothing, installs nothing and
an operation costs one inert call per module that reads the port. Composing
[`observability()`](/reference/observability) writes the failures as lines;
composing `otel()` beside it opens the spans and mints the instruments. Neither
changes a line of this composition.

```ts
export const Plain = Module("ReferencePlainStorage")({
  imports: [storage({ adapter: memoryStorage() })],
  exports: [Storage],
});
```

## What it deliberately does not do

- **No multipart form parsing.** A streamed write takes the body as a stream;
  decoding a form is the answerer's. A presigned PUT, which keeps the bytes
  out of the process entirely, remains the default for an upload the
  application need not see ([Upload a file](/how-to/upload-a-file)); streaming
  through the process is for one it must
  ([Stream a file through the process](/how-to/stream-a-file)).
- **No listing.** A real S3 feature, with no consumer here yet. Multipart upload
  exists only inside `putStream`; the port exposes no parts.
- **No tags.** User metadata is an atomic object description, not a tag index.
- **No bucket management.** Creating one is deployment, not runtime.
