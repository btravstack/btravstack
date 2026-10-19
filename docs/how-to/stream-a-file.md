---
title: Stream a file through the process
description: Serve a raw PUT and GET from an answerer of your own, streaming the body into storage and back out, in bounded memory and outside the JSON body limit — and know what a cut connection, the drain and the request timeout do to it.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import type { IncomingMessage } from "node:http";
import { Provider } from "@btravstack/di";
import { HttpHandler } from "@btravstack/http-server";
import { Storage } from "@btravstack/storage";
import { P } from "unthrown";

declare const authorizedKey: (request: IncomingMessage) => string | undefined;
-->

# Stream a file through the process

> **How-to.** Take an upload's bytes as they arrive and send a download's
> bytes as they are read, when the application must see them on the way —
> to encrypt, to hash, to refuse. For the ports, see
> [`@btravstack/storage`](/reference/storage) and
> [`HttpHandler`](/reference/http-server#httphandler-and-several-answerers).

When the application need not see the bytes, it should not carry them:
[Upload a file](/how-to/upload-a-file) hands the client a presigned URL
instead. Stream through the process when it must.

## 1. An answerer of your own

An oRPC procedure is the wrong shape for a file. oRPC reads a request body
that declares its length into a `File` in memory, and `bodyLimit` bounds it
(1 MiB by default). The runtime underneath reads no body at all: a bare
`HttpAnswerer` mounted beside the router gets the request as it arrives.

```ts
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const content = Provider.member(HttpHandler)({
  inject: { store: Storage },
  sync: ({ store }) => ({
    prefix: "/content",
    handle: async (request, response) => {
      const key = authorizedKey(request);
      if (key === undefined) return;

      if (request.method === "PUT") {
        const written = await store
          .putStream(key, Readable.toWeb(request) as ReadableStream<Uint8Array>, {
            contentType: request.headers["content-type"] ?? "application/octet-stream",
          })
          .map(() => 204)
          .recoverErrCases((matcher) =>
            matcher
              .with(P.tag("StorageUnavailable"), () => 503)
              .with(
                P.tag("InvalidStorageOptions"),
                P.tag("ChecksumMismatch"),
                P.tag("StreamInterrupted"),
                () => 400,
              ),
          );
        response.writeHead(written.getOr(500)).end();
        return;
      }

      const read = await store.getStream(key);
      if (!read.isOk()) {
        response.writeHead(read.isErr() && read.error._tag === "ObjectNotFound" ? 404 : 503).end();
        return;
      }
      const { stream, contentType, size } = read.value;
      response.writeHead(200, { "content-type": contentType, "content-length": size });
      await pipeline(Readable.fromWeb(stream as never), response);
    },
  }),
});
```

Provide it beside the router — `HttpModule`'s `provides` takes it — and the
runtime routes `/content` and everything under it here, by the longest
prefix. An answerer that returns without writing gets the runtime's `404`.

## 2. What it owes for itself

- **Authentication.** A route outside a contract carries no marker, so it is
  public until the answerer checks something. `authorizedKey` stands for that
  check: a session, a signed grant in the URL, whatever decides which key this
  request may touch.
- **A ceiling.** `bodyLimit` and `HTTP_BODY_LIMIT` bound what oRPC, fragments,
  GraphQL and MCP read; nothing bounds this body. Refuse a declared
  `content-length` you will not take before reading, and count the bytes as
  they pass: a transform that errors past the ceiling ends the write with
  `StreamInterrupted`, and nothing is stored.
- **Time.** `HTTP_REQUEST_TIMEOUT_MS` (default five minutes) bounds the whole
  request, body included. A large upload over a slow link needs a deployment
  that raises it.

## 3. What a failure does

- **A client that hangs up mid-upload** errors the request stream, so
  `putStream` answers `StreamInterrupted` and the multipart upload is aborted.
  No partial object is ever visible.
- **A store that breaks off mid-download** errors the stream, `pipeline`
  rejects, and the runtime destroys a response whose headers are already out.
  The client sees a reset connection, never a clean end of a short body.
- **The drain.** A transfer still in flight when `drainTimeoutMs` runs out is
  abandoned with its unit: its signal aborts and its connection is closed, so
  an upload ends as a hang-up does. Parts whose abort the exiting process
  never sent are not an object either; a bucket lifecycle rule for incomplete
  multipart uploads reaps them. Transfers that must outlive a deploy belong to
  a client that resumes, or to a presigned URL.
