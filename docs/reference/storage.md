---
title: "@btravstack/storage"
description: The complete surface of @btravstack/storage — the Storage and StorageBackend ports, StoredObject, ObjectNotFound, StorageUnavailable and PresignNotSupported, the memory and S3 adapters, storage(), the Observers seam it reports through, and the STORAGE_S3_* variables.
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
> the `Storage` port an application depends on, the three modeled failures and
> why they are three, the in-memory and S3-compatible adapters, and the one
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
          matcher.with(P.tag("StorageUnavailable"), () => undefined),
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

| Method                                                        | Answers                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `put(key, bytes, { contentType })`                            | `AsyncResult<void, StorageUnavailable>`                           |
| `get(key)`                                                    | `AsyncResult<StoredObject, ObjectNotFound \| StorageUnavailable>` |
| `delete(key)`                                                 | `AsyncResult<void, StorageUnavailable>`                           |
| `presignedUrl(key, { ttlMs })`                                | `AsyncResult<string, PresignNotSupported \| StorageUnavailable>`  |
| `presignedUpload(key, { ttlMs, contentType, contentLength })` | `AsyncResult<string, PresignNotSupported \| StorageUnavailable>`  |

`ttlMs` is **required on both presign arms** — there is no default, because a
link's lifetime is a security decision and a framework guessing at it is a
framework guessing at your threat model. The S3 adapter rounds **up** to whole
seconds (`expiresIn` is seconds), so `1_500` is a two-second URL; AWS's own
ceiling for SigV4 is seven days, and a longer one is refused by the store
rather than by this package.

**Bytes, not streams.** An object here is a document — an invoice, a
confirmation, an export — and `Uint8Array` is what every adapter and every
caller already has. Streaming would change every signature, adapter and test
to serve a case (multi-gigabyte media) that wants a different design anyway.

**Keys are yours**, tenant included: `orders/{tenantId}/{orderId}/confirmation.json`
is what the Temporal example composes, by hand, because a store is an
application service and the framework has no concept of a tenant to put in a
slot.

## Three failures, because they are three different facts

| Error                 | Means                          | What a caller does                                   |
| --------------------- | ------------------------------ | ---------------------------------------------------- |
| `ObjectNotFound`      | the key is not there           | gives up, or writes it                               |
| `StorageUnavailable`  | the store could not answer     | retries, degrades, or fails the request              |
| `PresignNotSupported` | this adapter cannot mint a URL | serves the bytes itself, or composes another adapter |

Collapsing them would cost the distinction that matters: a caller retries an
outage and does not retry an absence.

**`delete` is idempotent** — deleting a key nobody stored is `Ok`, which is
S3's own behaviour rather than a fiction layered over it.

**`presignedUpload` is how bytes get in.** It signs the key, the content type
and the content length, so the URL grants exactly one write, of exactly that
size, of exactly that type — a client sending anything else is refused by the
store. `contentLength` is required for that reason: it is the only ceiling a
presigned PUT can express, and an optional one would hand out an unbounded
write. The application still decides who may write what and for how long; the
adapter only computes the signature over that decision. See
[Upload a file](/how-to/upload-a-file).

**`presignedUrl` has no `ObjectNotFound` arm.** Presigning is a signature
computation and asks the store nothing, so a URL for an absent key is minted
happily and `404`s when it is followed. Checking would cost a HEAD request per
call, bought for something the caller usually does not want. Both halves were
measured against RustFS before the port was written.

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

One client, built with the scope and destroyed with it, against any
S3-compatible store: AWS, RustFS, MinIO, R2, B2.

| Variable                       | Required | Default     |
| ------------------------------ | -------- | ----------- |
| `STORAGE_S3_ENDPOINT`          | yes      | none        |
| `STORAGE_S3_BUCKET`            | yes      | none        |
| `STORAGE_S3_ACCESS_KEY_ID`     | yes      | none        |
| `STORAGE_S3_SECRET_ACCESS_KEY` | yes      | none        |
| `STORAGE_S3_REGION`            | no       | `us-east-1` |

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

| Signal  | Name                                                                                                                     | Attributes                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| span    | `storage.put` / `.get` / `.delete` / `.presigned_url` / `.presigned_upload`                                              | `btravstack.storage.key`; error status on a failure     |
| counter | `btravstack.storage.operations`                                                                                          | `{ operation, outcome }` — `ok`, `not_found` or `error` |
| log     | `"the object was not there"` / `"this store cannot mint a url"` at **`info`**; `"the store could not answer"` at `error` | `{ operation, key }`, with the failure as the cause     |

**A missing object is counted apart and logged at `info`, not `error`.**
Asking for something that is not there is an ordinary answer — a caller
checking whether a document exists yet meets it on the happy path — and a
dashboard that treats it as a fault teaches its readers to ignore the fault
line. `StorageUnavailable` is what pages somebody.

**A presign refusal shares that outcome and not that message.** It is the same
class of answer, so the counter says `not_found` for both — but the line says
`"this store cannot mint a url"`, because the object may be sitting exactly
where it was put, and an operator reading "the object was not there" would go
hunting for nothing.

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

- **No streaming, and no multipart parsing.** A presigned PUT is a different
  security decision — who may write what, for how long — and belongs to an
  application that has answered it.
- **No listing, no copy, and no S3 multipart upload.** Each is a real S3 feature, and none
  has a consumer here yet.
- **No metadata beyond the content type**, and no tags.
- **No bucket management.** Creating one is deployment, not runtime.
