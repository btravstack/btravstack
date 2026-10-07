---
title: Upload a file
description: Hand the client a presigned URL to write straight to the store, then decide whether and how your application accepts the uploaded bytes.
---

<!-- doctest: group=order-temporal-worker -->
<!-- doctest: prelude
import { Port, Provider } from "@btravstack/di";
import { Storage, StorageUnavailable, storage } from "@btravstack/storage";
import { s3Storage } from "@btravstack/storage/s3";
import { Module, type AnyPort } from "@btravstack/di";
import { OkAsync, P, TaggedError, type AsyncResult } from "unthrown";

type TenantId = string;
class TooLarge extends TaggedError("TooLarge")<{ readonly key: string }> {}
class UnsupportedType extends TaggedError("UnsupportedType")<{
  readonly contentType: string;
}> {}
-->

# Upload a file

> **How-to.** Let a client upload a file directly to the store, then decide
> whether the application needs to validate and accept it. For the port's
> surface, see [`@btravstack/storage`](/reference/storage).

## The three steps

1. The client tells you what it wants to write — the type, and how many bytes.
2. You decide whether it may, and hand back a URL for that key, type and size.
3. The client `PUT`s straight at the store, then tells you it is done.

Nothing in step 3 goes through your process, which is the point: an upload that
transits the application is a request held open for the length of a transfer, a
unit the drain has to wait on, and a copy of every byte in a process sized for
JSON. `@btravstack/storage` therefore has no multipart parsing and no streaming
request body — the store already accepts writes directly, and a presigned URL
is your time-limited permission to write a key.

## 1. Compose the starter

<!-- doctest: defer -->

```ts
export const AttachmentsApp = Module("AttachmentsApp")({
  imports: [storage({ adapter: s3Storage() })],
  provides: [attachments],
  exports: [Attachments],
});
```

`s3Storage()` binds `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`,
`STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY` (plus an optional
`STORAGE_S3_REGION`) through `Config`, and holds one client as a resource of
the graph. It works against any S3-compatible store — AWS, RustFS, MinIO, R2,
B2 — and the endpoint is **required rather than defaulted to AWS**, because a
default pointing at Amazon would be a surprising bill rather than a
convenience. The two `@aws-sdk` packages are **optional peers**, reached only
through the `@btravstack/storage/s3` subpath.

## 2. Minting the URL

`presignedUpload` signs the key, the content type and the content length. A
request with a different key, declared type or length is refused by the store.
The signature does not constrain which bytes fill that length.

It is **time-limited, not single-use**: until `ttlMs` runs out, the same URL
can `PUT` that key again and replace the object with different bytes of the
same size and type. The signature does not bind the bytes or prove that any
upload happened.

```ts
class Attachments extends Port("Attachments")<{
  readonly upload: (
    tenantId: TenantId,
    name: string,
    file: { readonly contentType: string; readonly sizeBytes: number },
  ) => AsyncResult<string, TooLarge | UnsupportedType | StorageUnavailable>;
  readonly download: (
    tenantId: TenantId,
    name: string,
  ) => AsyncResult<string, StorageUnavailable>;
}> {}

const ONE_MEGABYTE = 1_024 * 1_024;
const keyFor = (tenantId: TenantId, name: string) =>
  `attachments/${tenantId}/${name}`;

const attachments = Provider(Attachments)({
  inject: { store: Storage },
  sync: ({ store }) => ({
    // Your policy, as steps rather than guard clauses: each `ensure` names
    // the rule it enforces and passes the same file through. The URL cannot
    // be widened afterwards — what you sign is what the store will accept.
    upload: (tenantId, name, file) =>
      OkAsync(file)
        .ensure(
          (candidate) => candidate.sizeBytes <= 5 * ONE_MEGABYTE,
          () => new TooLarge({ key: keyFor(tenantId, name) }),
        )
        .ensure(
          (candidate) => candidate.contentType.startsWith("image/"),
          (candidate) =>
            new UnsupportedType({ contentType: candidate.contentType }),
        )
        .flatMap((accepted) =>
          store
            .presignedUpload(keyFor(tenantId, name), {
              ttlMs: 60_000,
              contentType: accepted.contentType,
              contentLength: accepted.sizeBytes,
            })
            // Folded HERE rather than at the end of the chain, so the
            // application's own two failures never meet the adapter's.
            .mapErrCases((matcher) =>
              // The memory adapter cannot presign, so a graph composed
              // without a real store fails here — loudly, in development.
              matcher
                .with(
                  P.tag("PresignNotSupported"),
                  () =>
                    new StorageUnavailable({
                      operation: "presignedUpload",
                      key: keyFor(tenantId, name),
                      reason: "this store cannot mint a url",
                    }),
                )
                .with(P.tag("StorageUnavailable"), (failure) => failure),
            ),
        ),
    // The same move in reverse: a time-limited read the client follows
    // itself. Serving those bytes through your own handler instead is the
    // anti-pattern this whole page exists to avoid.
    download: (tenantId, name) =>
      store
        .presignedUrl(keyFor(tenantId, name), { ttlMs: 60_000 })
        .mapErrCases((matcher) =>
          matcher
            .with(
              P.tag("PresignNotSupported"),
              () =>
                new StorageUnavailable({
                  operation: "presignedUrl",
                  key: keyFor(tenantId, name),
                  reason: "this store cannot mint a url",
                }),
            )
            .with(P.tag("StorageUnavailable"), (failure) => failure),
        ),
  }),
});
```

The client then writes the bytes itself:

```sh
curl -X PUT --upload-file avatar.png \
  -H 'content-type: image/png' \
  "$URL"
```

## Accepting the upload

The example signs the final key directly. Use that shape only when another
write before the URL expires is acceptable, such as a replaceable attachment.
A client's "done" call does not prove that an object exists or that its bytes
are the ones you intend to accept.

When the contents or final state matter, mint the URL for a unique staging key
per attempt. On confirmation, `get` that key, validate the actual bytes, then
`put` those same bytes under a final key for which no upload URL was issued.
Record acceptance in your application's state only after that write succeeds.
A replay can change the staging object, but not the accepted final object
through its URL. A missing staging object is `ObjectNotFound`; signed length
and type alone do not validate its contents.

This confirmation moves the bytes through your process once. For files too
large for that, use a store-native copy or another upload protocol in your
application's infrastructure. The storage port does not choose that policy.

## Reading it back

`presignedUrl` is the same move in reverse — the `download` arm above — and the
client fetches the object directly. Both arms fold `PresignNotSupported` into
`StorageUnavailable`, because an adapter that cannot sign is, from the
application's point of view, a store it cannot use.

## In development and in tests

`memoryStorage()` refuses to presign — both directions — rather than minting a
`file://` URL that would pass locally and fail in the deployment. So the
presigned flow has no in-process double: exercise it against a real
S3-compatible store. The repository's own suites run against the RustFS
container in `internal/test-infra`, which `pnpm dev` starts too, so the local
loop already has one.

A test that only needs the store to hold bytes still uses the memory adapter;
it is the presign arms specifically that need something real behind them.
