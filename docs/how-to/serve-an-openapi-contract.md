---
title: Serve an oRPC contract as OpenAPI routes
description: Keep one contract for TypeScript callers and conventional HTTP clients, generate its OpenAPI document, and choose whether to publish it.
---

# Serve an oRPC contract as OpenAPI routes

> **How-to.** Use this when a client needs ordinary HTTP methods, resource paths,
> and JSON bodies. The same contract can still be called over `/rpc` by an oRPC
> client. See [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) for
> the router and composition root.

Install the answerer's two required peers,
`@orpc/openapi@2.0.0-beta.44` and `@orpc/json-schema@2.0.0-beta.44`, in the
application. The contract package also needs `@orpc/openapi` for its routing
metadata.

## Declare the wire routes in the contract

Use oRPC's `openapi` metadata on each procedure that needs a resource path.
Path parameters must be required fields in the input schema. Without routing
metadata, the OpenAPI handler defaults to `POST` at the procedure's contract
path; it does not infer REST semantics from procedure names.

<!-- doctest: skip — a standalone contract fragment -->

```ts
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { z } from "zod";

export const contract = {
  items: {
    find: oc
      .meta(openapi({ method: "GET", path: "/items/{id}" }))
      .input(z.object({ id: z.string() }))
      .output(z.object({ id: z.string(), name: z.string() })),
    create: oc
      .meta(openapi({ method: "POST", path: "/items" }))
      .input(z.object({ name: z.string() }))
      .output(z.object({ id: z.string(), name: z.string() })),
  },
};
```

## Mount the OpenAPI answerer

Set `openapi` on the existing `HttpModule`. The OpenAPI answerer uses the same
router, authentication walk, unit lifecycle, and HTTP listener as the RPC
answerer. The default mounts are `/api` for OpenAPI and `/rpc` for RPC, so the
example above answers `GET /api/items/42`, `POST /api/items`, and the original
RPC procedures. A document by itself does not add these routes.

For a named refusal, put its HTTP `status` beside its `data` or `message` in
the procedure's `.errors(...)` entry, for example
`ITEM_MISSING: { status: 404, data: z.object({ id: z.string() }) }`.
The OpenAPI answerer and document generator use it locally to that procedure,
so each domain keeps its own declarations. The handler still returns its typed
`ErrAsync(errors.ITEM_MISSING({ data: { id } }))`; no root-level registry or
server import is needed in the contract. See
[Custom error statuses](/reference/http-server#custom-error-statuses).

<!-- doctest: skip — routerProvider is the application's existing router -->

```ts
import { HttpModule } from "@btravstack/orpc-server";

export const App = HttpModule("App")({
  router: routerProvider,
  openapi: true,
});
```

`openapi: { prefix: "/v1" }` changes only the OpenAPI mount. The record also
takes `cors`, `compression`, and `plugins`. `HttpModule`'s own `cors` and
`compression` apply to both answerers unless the record pins its own;
`plugins` stay per answerer. Set `bodyLimit`, `streamBodyLimit` and `csrf` on
`HttpModule` for both answerers. Deployed `HTTP_CORS_ORIGIN`, `HTTP_BODY_LIMIT`,
`HTTP_STREAM_BODY_LIMIT` and `HTTP_COMPRESSION` values are read by both. The listener's security headers,
cookie-based CSRF check, request unit, and drain apply to both answerers.

## Stream a binary body

A route can take its body as bytes in flight and answer with bytes in flight,
for a file the application must see on the way — to encrypt, to hash, to
store. Declare `requestBodyHint: "octet-stream"` with the `detailed` input
structure, and the handler gets `body` as a `ReadableStream` while the client
is still sending. An `outputStructure: "detailed"` answer whose `body` is a
`ReadableStream` streams out under the `headers` it names; declare
`responseBodyHint: "octet-stream"` on that route too.

<!-- doctest: skip — a standalone contract fragment -->

```ts
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { z } from "zod";

export const contract = {
  files: {
    upload: oc
      .meta(
        openapi({
          method: "PUT",
          path: "/files/{key}",
          inputStructure: "detailed",
          requestBodyHint: "octet-stream",
        }),
      )
      .input(
        z.object({
          params: z.object({ key: z.string() }),
          headers: z.object({ "content-type": z.string().optional() }),
          body: z.instanceof(ReadableStream),
        }),
      )
      .output(z.object({ key: z.string() })),
    download: oc
      .meta(
        openapi({
          method: "GET",
          path: "/files/{key}",
          outputStructure: "detailed",
          responseBodyHint: "octet-stream",
        }),
      )
      .input(z.object({ key: z.string() }))
      .output(
        z.object({
          headers: z.object({
            "content-type": z.string(),
            "content-length": z.string().optional(),
            "content-disposition": z.string(),
          }),
          body: z.instanceof(ReadableStream),
        }),
      ),
  },
};
```

The streamed body is bounded by `streamBodyLimit` (`HTTP_STREAM_BODY_LIMIT`,
1 GiB by default), not by `bodyLimit`, which keeps bounding every body read
whole. A declared `content-length` over the limit answers `413` before a
byte is read. A body that declares none, or lies, errors the handler's
stream with oRPC's `PAYLOAD_TOO_LARGE` once it passes the limit, and the
request answers `413` whatever the handler made of that error. The hint is
the route's: a client cannot pick the larger limit by its headers, and the
RPC wire reads every body under `bodyLimit`.

A procedure that streams a body is served by the OpenAPI routes only, and
its route says so: the upload's `requestBodyHint: "octet-stream"`, and
`responseBodyHint: "octet-stream"` on the download. The RPC answerer leaves
both unmatched, so `/rpc` answers `404` before the handler runs and a
download never opens a stream nothing would read. A typed RPC client built
from the contract still lists them, and calling one through `RPCLink` gets
that `404`: call it with `fetch` or an OpenAPI client on its route instead.
A download that forgets `responseBodyHint` still streams over OpenAPI, but
over `/rpc` its handler runs. Every stream found in the answer has its
cancellation started, without waiting, and the call answers `500` at once,
reported to `Observers` as a defect, rather than `{}`. The answer's objects,
arrays, maps and sets are searched. A stream the handler holds a reader on is
locked, and the backstop cannot free it: it is reported as a defect of its
own, and releasing it is the handler's job.

A download stream that errors midway resets the connection, so the client's
read rejects rather than ending cleanly on a short body; response
compression, when on, keeps that. `HTTP_REQUEST_TIMEOUT_MS` (five minutes by
default) still bounds the whole request, so a large upload over a slow link
needs a deployment that raises it.

## Generate a document for tooling

`openApiDocument()` already generates a document from the contract, including
the `authenticated()` marker's security requirements. It runs without booting a
server. Write its result to a file in the application's build or CI script, then
give that file to an OpenAPI diff tool or client generator. The `servers` URL
must point at the OpenAPI mount, not `/rpc`.

<!-- doctest: skip — application-specific build script -->

```ts
import { writeFile } from "node:fs/promises";
import { contract } from "./contract.js";
import { openApiDocument } from "@btravstack/orpc-server/openapi";

const document = (
  await openApiDocument(contract, {
    base: {
      info: { title: "Items API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com/api" }],
    },
  })
).get();

await writeFile("openapi.json", `${JSON.stringify(document, null, 2)}\n`);
```

The application supplies its scheme definitions through `securitySchemes` when
it uses authentication. Compare the generated file with the last published API
version to detect breaking changes. No running `/openapi.json` endpoint is
needed for that check.

## Publish the document only for its audience

For a public API, serving the matching document is useful: generic clients and
API reference tools can discover the contract. For an internal API, keep the
generated artifact in CI or publish it through an authenticated gateway. The
framework does not mount a spec or UI route by default. An OpenAPI document
describes authorization requirements; it does not grant access to an endpoint.

When public documentation is wanted, oRPC's
[OpenAPI reference plugin](https://orpc.dev/docs/plugins/openapi-reference)
can be passed in `openApiRoutes({ plugins: [...] })`. Give its `spec` callback
the result of **this package's** `openApiDocument()`, so `authenticated()`
requirements are retained. The pinned oRPC `2.0.0-beta.44` plugin serves its
spec and UI publicly by default. For a private document, supply its `allow`
predicate to gate both routes or protect them at the gateway.
