---
title: List what a process serves
description: Print every route an HTTP deployment answers — the oRPC procedures from its OpenAPI document, the htmx and login routes from its composition root — and find out what its graph resolved to without a runtime dump.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { openApi } from "../../openapi.js";
import { orderRowFragment } from "../../slices/orders/fragment.js";
-->

# List what a process serves

> **How-to.** Answer "which paths does this deployment actually serve?" with
> what already ships, and "what did its graph resolve to?" with the compiler.
> For the document itself, see
> [`openApiDocument()`](/reference/http-server#openapidocument-—-from-btravstack-http-server-openapi);
> for the deployment these samples come from, [Order API (HTTP)](/examples/order-api).

A modulith composes several slices into one router, so no single contract file
says what the process serves — the composed contract does, and
`openApiDocument` already turns it into a route list in a standard format.
There is no `routes` command and no runtime introspection endpoint: the list is
a few lines over that document.

## 1. The oRPC procedures: read the OpenAPI document

`examples/order-api/src/openapi.ts` already builds the deployment's document as
`openApi()`. Every operation in it is a procedure the router answers:

```ts
const METHODS = new Set(["get", "put", "post", "patch", "delete"]);

export const procedures = openApi().map((document) =>
  Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item ?? {})
      .filter((key) => METHODS.has(key))
      .map((method) => `${method.toUpperCase()} /rpc${path}`),
  ),
);
```

`/rpc` is `http()`'s default `prefix`, the mount oRPC's answerer is routed
under. The path after it is the procedure's — the document writes
`/orders/place` for `orders.place`, and oRPC's RPC handler serves it at
`/rpc/orders/place` — so the two agree unless a procedure declares an OpenAPI
`route` path of its own, which the document follows and the RPC handler does
not.

## 2. The routes outside the contract: read the root

An htmx fragment and the login answerer are not procedures, so they are not in
the document. They are in the **composition root**, and each says where it
answers. A fragment piece carries its own method and path, so map the same
array the root hands `api.HtmxFragments([...])`:

```ts
export const fragmentRoutes = [orderRowFragment].map(
  ({ route }) => `${route.method} ${route.path}`,
);
```

`oidc()` answers three fixed routes under its `prefix` (`/auth` by default):
`GET /auth/login`, `GET /auth/callback` and `POST /auth/logout`. The runtime's
own `404` covers every other path, and the probes are on their own port.

## 3. Print it

As a script beside the root, run with `tsx`:

```ts
for (const line of [...(await procedures).get(), ...fragmentRoutes]) console.log(line);
```

```text
POST /rpc/orders/place
POST /rpc/orders/find
POST /rpc/orders/list
POST /rpc/orders/export
POST /rpc/customers/find
GET /orders/:id/row
```

`examples/order-api/src/openapi.spec.ts` pins the same document path by path,
so a procedure that drops out of the composed router fails a test rather than
this list.

## What the graph resolved to: ask the compiler

There is no graph dump and no REPL against a booted application, and that is
a decision rather than a gap. The graph is **proven at compile time**: a
provider nobody supplies, a slice the root forgot to import, a piece two slices
both mint — each is a compile error at the composition root naming the port,
or, for the duplicate, di's own defect at build. A dump would print a graph the
type checker has already accepted, and the failure it was meant to debug does
not reach runtime. So:

- **"Why does it not build?"** — `pnpm typecheck`, and
  [Read a wiring error](/how-to/read-a-wiring-error) for where the port's name
  is in the message.
- **"What would this port do against the real graph?"** — a test that boots the
  real root: [Test an application](/how-to/test-an-application), with
  [`tapped`](/reference/testing#tapped-module-ports) to reach a port from
  outside.

## Where to go next

- The document's surface and its security fold:
  [`openApiDocument()`](/reference/http-server#openapidocument-—-from-btravstack-http-server-openapi).
- Several answerers under one runtime:
  [`HttpHandler`, and several answerers](/reference/http-server#httphandler-and-several-answerers).
- How the compile-time proof works: [Compile-time wiring](/explanation/compile-time-wiring).
