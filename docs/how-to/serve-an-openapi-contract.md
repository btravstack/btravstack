---
title: Serve an oRPC contract as OpenAPI routes
description: Keep one contract for TypeScript callers and conventional HTTP clients, generate its OpenAPI document, and choose whether to publish it.
---

# Serve an oRPC contract as OpenAPI routes

> **How-to.** Use this when a client needs ordinary HTTP methods, resource paths,
> and JSON bodies. The same contract can still be called over `/rpc` by an oRPC
> client. See [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) for
> the router and composition root.

Install the `/openapi` subpath's two optional peers,
`@orpc/openapi@2.0.0-beta.28` and `@orpc/json-schema@2.0.0-beta.28`, in the
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
`plugins` stay per answerer. Set `bodyLimit` and `csrf` on `HttpModule` for
both answerers. A root built on `http()` instead of `HttpModule` adds
`openApiRoutes()` from `@btravstack/orpc-server/openapi` to its `provides`,
with the same options. Deployed
`HTTP_CORS_ORIGIN`, `HTTP_BODY_LIMIT`, and `HTTP_COMPRESSION` values are read by
both. The listener's security headers,
cookie-based CSRF check, request unit, and drain apply to both answerers.

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
requirements are retained. The pinned oRPC `2.0.0-beta.28` plugin serves its
spec and UI publicly when installed; protect them at the gateway if the
document is private.
