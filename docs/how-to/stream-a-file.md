---
title: Stream a file through the process
description: Serve a raw PUT and GET from an answerer of your own, streaming the body into storage and back out, in bounded memory and outside the JSON body limit — know what a cut connection, the drain and the request timeout do to it, and size the store's stream pool.
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

A contract route can stream a file when its OpenAPI metadata says so:
[Stream a binary body](/how-to/serve-an-openapi-contract#stream-a-binary-body)
declares `requestBodyHint: "octet-stream"`, and `streamBodyLimit` bounds it.
Any other oRPC procedure reads a request body that declares its length into a
`File` in memory, under `bodyLimit` (1 MiB by default). For a route outside
the contract, the runtime underneath reads no body at all: a bare
`HttpAnswerer` mounted beside the router gets the request as it arrives.

```ts
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CEILING = 1_073_741_824;

/** Passes the bytes through, and errors the stream once more than `ceiling` have passed. */
const capped = (ceiling: number) => {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      seen += chunk.byteLength;
      if (seen > ceiling) controller.error(new RangeError("the body is over the ceiling"));
      else controller.enqueue(chunk);
    },
  });
};

export const content = Provider.member(HttpHandler)({
  inject: { store: Storage },
  sync: ({ store }) => ({
    prefix: "/content",
    handle: async (request, response) => {
      const key = authorizedKey(request);
      if (key === undefined) return;

      if (request.method === "PUT") {
        if (Number(request.headers["content-length"] ?? 0) > CEILING) {
          response.writeHead(413).end();
          return;
        }
        const body = (Readable.toWeb(request) as ReadableStream<Uint8Array>).pipeThrough(
          capped(CEILING),
        );
        const written = await store
          .putStream(key, body, {
            contentType: request.headers["content-type"] ?? "application/octet-stream",
          })
          .map(() => 204)
          .recoverErrCases((matcher) =>
            matcher
              .with(P.tag("StorageUnavailable"), P.tag("StreamPoolFull"), () => 503)
              .with(P.tag("StreamInterrupted"), ({ cause }) =>
                cause instanceof RangeError ? 413 : 400,
              )
              .with(P.tag("InvalidStorageOptions"), P.tag("ChecksumMismatch"), () => 400),
          );
        response.writeHead(written.getOr(500)).end();
        return;
      }

      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET, PUT" }).end();
        return;
      }
      const read = await store.getStream(key);
      if (!read.isOk()) {
        response.writeHead(read.isErr() && read.error._tag === "ObjectNotFound" ? 404 : 503).end();
        return;
      }
      const { stream, contentType, size } = read.value;
      response.writeHead(200, {
        "content-type": contentType,
        ...(size === undefined ? {} : { "content-length": size }),
      });
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
- **A ceiling.** `bodyLimit`, `streamBodyLimit` and their variables bound what
  oRPC, fragments, GraphQL and MCP read; nothing bounds this body. The answerer above refuses a
  declared `content-length` over its ceiling before reading, and counts the
  bytes as they pass, since a chunked body declares none: `capped` errors the
  stream past the ceiling, the write ends with `StreamInterrupted` carrying
  that error, and nothing is stored. Keep it well under the store's own
  ceiling for a streamed object.
- **Time.** `HTTP_REQUEST_TIMEOUT_MS` (default five minutes) bounds the whole
  request, body included. A large upload over a slow link needs a deployment
  that raises it.
- **A share of the store's sockets.** See below: the adapter bounds how many
  transfers run at once, and the ingress bounds who may hold them.

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

## 4. Size the stream pool

`s3Storage()` keeps two socket pools. `getStream`, `putStream` and
`putStreamIfAbsent` use one of their own, `STORAGE_S3_STREAM_MAX_SOCKETS`
sockets (default `50`, the AWS SDK's own pool size); every other call shares
the other, `STORAGE_S3_MAX_SOCKETS` (also `50`). A stream holds its socket
from the call until it closes, read to its end, cancelled or broken off, and a
streamed write until it settles. Fifty clients reading slowly therefore hold
the stream pool, never the sockets a `head`, a `put` or the health check needs.

**One transfer more than the pool holds is refused at once**, with
`StreamPoolFull` naming the bound (`maxSockets`); a write's stream is cancelled.
Answer `503`, as the sample does, with a `Retry-After` if clients honour it,
so the transfer is retried once a slot is free or on a replica with room. The adapter refuses rather than queues:
a queued transfer would wait for a reader elsewhere to finish, which nothing in
this process bounds, so the request would hang instead of being shed. Each
refusal is counted as `result: "saturated"` on `btravstack.storage.operations`,
the rate to alert on.

**Size it as the transfers one replica serves at once**: the transfers a
second, times how long one lasts. Two costs set the ceiling. An upload holds
up to 16 MiB while it reads and sends a part, so the pool times 16 MiB must fit
the container's memory beside everything else; and the replica's bandwidth is
shared by every transfer in flight, so more of them each run slower. Raise the
replicas, not just the pool, when the saturation rate climbs.

```sh
STORAGE_S3_STREAM_MAX_SOCKETS=20   # 20 transfers at once, up to 320 MiB of upload parts
STORAGE_S3_MAX_SOCKETS=50          # the short calls keep the SDK's default
```

**The pool keeps slow transfers from starving short calls; it does not keep
one client from taking every slot.** The ingress in front of the service still
needs:

- **connections per client**, capped below the pool, so one caller cannot hold
  every stream socket and shed everyone else;
- **a minimum transfer rate**, so a reader that stops reading, or a writer that
  stops sending, gives its slot back. Node's HTTP server has none:
  `HTTP_REQUEST_TIMEOUT_MS` bounds what the client sends and nothing bounds
  how slowly it reads the response, so a stalled download holds its slot until
  the client hangs up. Set an idle or minimum-rate timeout at the proxy or
  load balancer in front of the service.

`STORAGE_S3_CONNECTION_TIMEOUT_MS`, `STORAGE_S3_SOCKET_TIMEOUT_MS` and
`STORAGE_S3_REQUEST_TIMEOUT_MS` bound the store's side of a call; their
meaning is on [the reference page](/reference/storage#s3storage).
