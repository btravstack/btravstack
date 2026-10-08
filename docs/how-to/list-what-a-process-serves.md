---
title: List what a process serves
description: Print every route an HTTP deployment answers — the oRPC procedures from its OpenAPI document, the htmx and login routes from its composition root — and find out what its graph resolved to without a runtime dump.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { contract } from "@btravstack/example-order-api-contract";
import { openApi } from "../../openapi.js";
import { orderRowFragment } from "../../slices/orders/fragment.js";
-->

# List what a process serves

> **How-to.** Answer "which paths does this deployment actually serve?" with
> what already ships, and "what did its graph resolve to?" with the compiler.
> For the document itself, see
> [`openApiDocument()`](/reference/http-server#openapidocument-—-from-btravstack-orpc-server-openapi);
> for the deployment these samples come from, [Order API (HTTP)](/examples/order-api).

A modulith composes several slices into one router, so no single contract file
says what the process serves — the composed contract does, and
`openApiDocument` already turns it into a route list in a standard format.
There is no `routes` command and no runtime introspection endpoint: the list is
a few lines over that document.

## 1. The oRPC procedures: read the OpenAPI document

`examples/order-api/src/openapi.ts` already builds the deployment's document as
`openApi()`. Every operation in it is a procedure the router answers — but the
document describes an OpenAPI handler, and this deployment serves oRPC's
**RPC** handler, so the methods are not read off it. They follow the runtime's
two rules instead: every procedure is answered on `POST`, and one whose
declared output is an event iterator is answered on `GET` as well, since a
browser's `EventSource` can only GET.

The second rule is read from the **contract**, exactly where `orpc()` reads it
— the procedure's own `outputSchemas` — and not from the document's response
content, which an `openapi({ spec })` on the procedure can replace or strip
while the runtime still admits the GET:

```ts
import {
  getAsyncIteratorObjectSchemaDetails,
  getContractRouter,
  type AnyContractProcedure,
  type AnyContractRouter,
} from "@orpc/contract";

const isProcedure = (node: AnyContractRouter | undefined): node is AnyContractProcedure =>
  node !== undefined && "~orpc" in node;

const streams = (segments: readonly string[]): boolean => {
  const procedure = getContractRouter(contract, segments);
  return (
    isProcedure(procedure) &&
    (procedure["~orpc"].outputSchemas ?? []).some(
      (schema) => getAsyncIteratorObjectSchemaDetails(schema) !== undefined,
    )
  );
};

export const procedures = openApi().map((document) =>
  Object.keys(document.paths ?? {}).flatMap((path) =>
    streams(path.slice(1).split("/"))
      ? [`POST /rpc${path}`, `GET /rpc${path}`]
      : [`POST /rpc${path}`],
  ),
);
```

`contract` is the one the root composes its router from,
`@btravstack/example-order-api-contract`'s. `/rpc` is `http()`'s default
`prefix`, the mount oRPC's answerer is routed under. The path after it is the
procedure's — the document writes `/orders/place` for `orders.place`, and the
RPC handler serves it at `/rpc/orders/place` — which is also how a document
path finds its procedure in the contract.

**The recipe is scoped to a contract whose procedures keep their own paths.** A
procedure that sets an OpenAPI path of its own (`openapi({ path })` or a
`prefix` in its meta) is written in the document at that path, while the RPC
handler still serves it at its contract path — and the document carries no
record of the contract path to recover. `examples/order-api-contract` sets
none; a contract that does lists those procedures by hand.

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

`oidc()` answers three fixed routes under the `prefix` the root passes it
(`/auth` by default, which is what `examples/order-api` uses):

```ts
const oidcPrefix = "/auth";

export const loginRoutes = [
  `GET ${oidcPrefix}/login`,
  `GET ${oidcPrefix}/callback`,
  `POST ${oidcPrefix}/logout`,
];
```

The runtime's own `404` covers every other path on this listener.

## 3. The probe listener: the kernel's own routes

The process answers on a **second** port too. `runMain` (and `start`) runs the
kernel's probe server on `PROBE_PORT` — `9000` by default, ephemeral under
`pnpm dev`, which sets it to `0` — unless the root is started with
`probes: false`:

```ts
export const probeRoutes = ["GET /livez", "GET /readyz", "GET /healthz"];
```

They are on their own listener so that the Service routing traffic to the pod
never exposes them; what each answers in each phase is
[Probes](/reference/core/probes).

## 4. Print it

As a script beside the root, run with `tsx` — one block per listener:

```ts
console.log("on PORT:");
for (const line of [...(await procedures).get(), ...fragmentRoutes, ...loginRoutes]) {
  console.log(`  ${line}`);
}
console.log("on PROBE_PORT:");
for (const line of probeRoutes) console.log(`  ${line}`);
```

```text
on PORT:
  POST /rpc/orders/place
  POST /rpc/orders/find
  POST /rpc/orders/list
  POST /rpc/orders/export
  POST /rpc/customers/find
  GET /orders/:id/row
  GET /auth/login
  GET /auth/callback
  POST /auth/logout
on PROBE_PORT:
  GET /livez
  GET /readyz
  GET /healthz
```

No procedure here streams, so no `GET /rpc/…` line appears; a procedure served
as in [Stream with server-sent events](/how-to/stream-with-server-sent-events)
would print both of its methods.

**What makes the document's list the router's list is the compiler, not a
test.** `openApi()` is built from the contract alone and never sees the router,
so `examples/order-api/src/openapi.spec.ts` pins the document and nothing about
coverage. The coverage guarantee is `api.OrpcRouter(contract)([...])`'s: a
controller dropped from that array, or a contract procedure no controller
serves, is an `UNCOVERED CONTROLLERS` compile error at the root — so every
procedure the contract declares is one the composed router answers.

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
  [`openApiDocument()`](/reference/http-server#openapidocument-—-from-btravstack-orpc-server-openapi).
- Several answerers under one runtime:
  [`HttpHandler`, and several answerers](/reference/http-server#httphandler-and-several-answerers).
- How the compile-time proof works: [Compile-time wiring](/explanation/compile-time-wiring).
