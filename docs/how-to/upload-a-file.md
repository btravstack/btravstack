---
title: Upload a file
description: Hand the client a presigned URL and let it write straight to the store — the bytes never pass through your process, and the signature is what makes the write safe.
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

> **How-to.** Accept a file from a client without the bytes going through your
> process, and read one back the same way. For the port's surface, see
> [`@btravstack/storage`](/reference/storage).

## The three steps

1. The client tells you what it wants to write — the type, and how many bytes.
2. You decide whether it may, and hand back a URL good for exactly that write.
3. The client `PUT`s straight at the store, then tells you it is done.

Nothing in step 3 goes through your process, which is the point: an upload that
transits the application is a request held open for the length of a transfer, a
unit the drain has to wait on, and a copy of every byte in a process sized for
JSON. `@btravstack/storage` therefore has no multipart parsing and no streaming
request body — the store already accepts writes directly, and a presigned URL
is your permission for one, written down.

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

`presignedUpload` signs the key, the content type and the content length. All
three are part of the signature, so the URL grants exactly one write, of
exactly that many bytes, of exactly that type — a client that sends anything
else is refused by the store, not by you.

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

## There is nothing to verify afterwards

The step people expect next is a check that the client uploaded what it said it
would. There is none to write, because the signature already did it: the only
object the URL could have produced is one of that type and that exact size, at
that exact key. A client that lied gets a `403` and stores nothing.

What is still unknown is whether the write happened **at all** — a client can
take a URL and walk away. So step 3 is a call into your own application that
records the attachment against the order, the profile, whatever owns it, and
the object being absent later is an ordinary `ObjectNotFound` on the read. Do
not model "pending upload" as a state the store is asked about; model it as a
row you already have.

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
