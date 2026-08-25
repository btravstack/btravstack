---
layout: home
title: btravstack — dependency injection TypeScript can actually check
description: A TypeScript backend framework whose wiring is proven by the compiler — modules and DI without decorators or reflect-metadata, errors as values, and a drain that survives Kubernetes.

hero:
  name: "btravstack"
  text: "Dependency injection TypeScript can actually check"
  tagline: Modules and DI without decorators or reflect-metadata — a missing provider is a compile error at the call site, not a stack trace at boot. Nothing throws. SIGTERM drains in-flight work the way Kubernetes needs.
  actions:
    - theme: brand
      text: Get Started
      link: /tutorial/getting-started
    - theme: alt
      text: Coming from NestJS →
      link: /explanation/coming-from-nestjs
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/start

features:
  - title: Wiring proven at compile time
    details: A module that forgets a provider is a compile error naming the missing ports; a root with no runtime, or a runtime resolving a port the root does not export, fails at the start call. No decorators, no reflect-metadata, no missing provider discovered at boot.
  - title: Nothing throws
    details: Every async surface returns an unthrown AsyncResult, the startup error channel stays the application's own, and one place — runMain — decides the process exit code.
  - title: One process, one runtime
    details: An API, a Temporal worker and an AMQP consumer are three processes booting the same module under a different composition root. The runtime is a service of the module, and a graph holds exactly one.
  - title: A drain that survives Kubernetes
    details: SIGTERM flips readiness, waits for endpoint removal to catch up, then stops accepting and gives in-flight work a deadline. Whatever is still open is reported abandoned, not lost silently.
---

<!-- doctest: prelude
import { observability } from "@btravstack/observability";
import { OrderApplicationModule, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { api } from "../../auth.js";
-->

## At a glance

`examples/order-api`'s **orders slice**, served on its own and condensed to one
procedure: a contract, a router that is a provider, an authenticator, a
composition root, and one call. The example itself composes that slice and a
`customers` one into a single router through
[controllers](/how-to/split-a-router-into-controllers).

```ts
import { authenticated } from "@btravstack/contract";
import { runMain } from "@btravstack/core";
import { HttpModule } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { P } from "unthrown";
import { z } from "zod";

import { OrderApplicationModule, PlaceOrder } from "./application.js";
import { api } from "./auth.js";
import { OrderPersistenceModule } from "./persistence.js";

// The contract comes first; a client can take it without the server.
// Schemas, not oRPC's `type<T>()`: they check what arrives, not just what compiles.
const orderView = z.object({ id: z.uuidv7(), quantity: z.number() });
const orderRef = z.object({ id: z.uuidv7() });
// `BAD_REQUEST` names the id **as received**, which is the one value that is
// not a UUIDv7: `orderRef` would reject the only payload it ever carries.
const malformedRef = z.object({ id: z.string() });

// `authenticated` marks the fragment with an OpenAPI security requirement —
// the `user` scheme, no scopes. It names no tenant on the input: a caller does
// not get to pick the tenant it is served.
const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(orderView)
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: malformedRef },
      CONFLICT: { data: orderRef },
    }),
});

// The router is a provider: it declares the use case its procedure calls.
// Every domain error is named here — the one place a Result becomes HTTP.
const ordersRouter = api.HttpRouter(ordersContract)(
  { place: PlaceOrder },
  {
    sync: ({ place }) => ({
      place: ({ errors, context }, input) =>
        place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map((order) => ({ id: order.id, quantity: order.quantity }))
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({
                  message: error.message,
                  data: { id: error.id },
                }),
              )
              // A malformed id is the caller's mistake, so 400 — not the
              // 409 a duplicate gets.
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.BAD_REQUEST({
                  message: error.message,
                  data: { id: error.id },
                }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({
                  message: error.message,
                  data: { id: error.id },
                }),
              ),
          ),
    }),
  },
);

// The composition root. The runtime is a service of this module.
const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
});

// main.ts — the whole process.
await runMain(OrdersApi);
```

**The runtime is a service of the module, not an option.** `HttpModule` imports
the HTTP starter, provides the router and exports `HttpRuntime`; `runMain`
builds the graph, resolves that port and drives what it finds. `PORT` and
`HOST` are read from the environment _inside_ the graph, through a
configuration provider — nothing in `main.ts` touches `process.env`, and a
malformed value is a `startFailed` event and exit code `78`.

**The contract says _which schemes_ protect a route; the application says
_what each one is_.** `authenticated({ user: [] })` is the fact a client reads
off the contract; `defineHttp({ authenticators })` in `auth.ts` is what mints
the `api.HttpRouter` above, so `context.principal` is typed where the handler
is written. The authenticators ride the router, so the root lists none — and a
scheme with nobody behind it is an unmet dependency naming the port. A required
**scope** the credential lacks is a `403`, distinct from the `401` a caller
with no valid credential gets. See
[Protect a procedure](/how-to/protect-a-procedure).

**SIGTERM drains in three beats.** Readiness flips false; the kernel waits for
Kubernetes to stop routing to the pod _before_ telling the runtime to stop
accepting; then in-flight requests get a deadline, and whatever is still open
is aborted and reported `abandoned` in the [exit report](/reference/core/exit-report).
Beat two is the whole point — see [Draining, in three beats](/explanation/draining-in-three-beats).

## Packages

Twelve published packages in four groups — the kernel and its plumbing, one
server per transport, capability ports, and the harness. Every one of them is
listed with its install command on [Packages and install](/reference/packages).
