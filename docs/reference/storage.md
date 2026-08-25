---
title: "@btravstack/storage"
description: The complete surface of @btravstack/storage — the Storage and StorageBackend ports, StoredObject, ObjectNotFound, StorageUnavailable and PresignNotSupported, the memory and S3 adapters, storage() and its instrumented flag, and the STORAGE_S3_* variables.
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
> composition function that decides whether operations are instrumented.

## The port

```ts
export const documents = Provider(
  Port("ReferenceDocuments")<{
    readonly save: (key: string, pdf: Uint8Array) => AsyncResult<void, never>;
    readonly link: (key: string) => AsyncResult<string | undefined, never>;
  }>,
)(
  { store: Storage },
  {
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
  },
);
```

| Method                             | Answers                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `put(key, bytes, { contentType })` | `AsyncResult<void, StorageUnavailable>`                           |
| `get(key)`                         | `AsyncResult<StoredObject, ObjectNotFound \| StorageUnavailable>` |
| `delete(key)`                      | `AsyncResult<void, StorageUnavailable>`                           |
| `presignedUrl(key, { ttlMs })`     | `AsyncResult<string, PresignNotSupported \| StorageUnavailable>`  |

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

## `storage({ adapter, instrumented? })`

```ts
export const DocumentsApp = Module("ReferenceDocumentsApp")({
  imports: [storage({ adapter: s3Storage() }), observability(), otel()],
  provides: [documents],
  exports: [Storage, Logger],
});
```

| Signal  | Name                                                                                  | Attributes                                              |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| span    | `storage.put` / `.get` / `.delete` / `.presigned_url`                                 | `btravstack.storage.key`; error status on a failure     |
| counter | `btravstack.storage.operations`                                                       | `{ operation, outcome }` — `ok`, `not_found` or `error` |
| log     | `"the object was not there"` at **`info`**; `"the store could not answer"` at `error` | `{ operation, key }`, with the failure as the cause     |

**A missing object is counted apart and logged at `info`, not `error`.**
Asking for something that is not there is an ordinary answer — a caller
checking whether a document exists yet meets it on the happy path — and a
dashboard that treats it as a fault teaches its readers to ignore the fault
line. `StorageUnavailable` is what pages somebody.

**Instrumented by default**, `instrumented: false` opts out — the same shape,
and the same reasoning, as [`@btravstack/cache`](/reference/cache).

The uninstrumented graph, for a process that wants none of it:

```ts
export const Plain = Module("ReferencePlainStorage")({
  imports: [storage({ adapter: memoryStorage(), instrumented: false })],
  exports: [Storage],
});
```

## What it deliberately does not do

- **No streaming, and no presigned writes.** A presigned PUT is a different
  security decision — who may write what, for how long — and belongs to an
  application that has answered it.
- **No listing, no copy, no multipart.** Each is a real S3 feature, and none
  has a consumer here yet.
- **No metadata beyond the content type**, and no tags.
- **No bucket management.** Creating one is deployment, not runtime.
