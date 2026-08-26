---
layout: home
title: btravstack — a backend framework for Node.js and TypeScript
description: A backend framework for Node.js and TypeScript. Modules and dependency injection the compiler proves, errors as values instead of exceptions, and one process per runtime — HTTP, Temporal or AMQP.

hero:
  name: "btravstack"
  text: "A backend framework for Node.js and TypeScript"
  tagline: Write the business code. The framework proves the wiring at compile time, keeps errors as values instead of exceptions, and shuts down the way Kubernetes expects.
  actions:
    - theme: brand
      text: Get Started
      link: /tutorial/getting-started
    - theme: alt
      text: How it compares
      link: /explanation/coming-from-nestjs
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/btravstack

features:
  - title: Wiring proven at compile time
    details: A module that forgets a provider is a compile error naming the missing port — not a stack trace at boot. No decorators, no reflect-metadata.
  - title: Nothing throws
    details: Every async surface returns a Result. A failure is a value with a type, so the compiler makes you handle it and no error escapes unnoticed.
  - title: HTTP, Temporal and AMQP
    details: One process runs one runtime. The same application module boots as an API, a workflow worker or a queue consumer — three deployments, one codebase.
  - title: Built for Kubernetes
    details: SIGTERM flips readiness, waits for the load balancer to catch up, then drains in-flight work against a deadline. Correct shutdown is the default, not an exercise.
---

## What it is

btravstack is a **backend framework for Node.js**, written for TypeScript
rather than adapted to it. You build an application out of ports and providers;
the compiler checks that everything one needs, another supplies. Then a
**starter** brings the transport — an HTTP server, a Temporal worker, an AMQP
consumer — and the framework owns the process: boot, readiness, shutdown.

It is not a full-stack framework. There is no ORM, no templating, no frontend.
It is the layer between your business logic and the process it runs in.

## What you get

|                          |                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Dependency injection** | Plain values, no decorators or `reflect-metadata`. Unmet dependencies are compile errors.                |
| **Errors as values**     | Every fallible call returns a `Result`. Domain errors are typed and exhaustively matched.                |
| **Configuration**        | Environment variables validated once, at boot, into typed values. A bad value exits `78` and says which. |
| **Three transports**     | HTTP (contract-first, over oRPC), Temporal workers, AMQP consumers.                                      |
| **Observability**        | Structured logs correlated per request, OpenTelemetry traces and metrics.                                |
| **Lifecycle**            | Health probes, graceful drain, resource cleanup on every exit path.                                      |
| **Testing**              | A harness that boots the real graph and swaps one provider at a time.                                    |

## What it looks like

An HTTP API is four files: a contract, a router that implements it, a
composition root, and an entry point.

**`contract.ts`** — what the API promises. A client can take this file alone.

<!-- doctest: prelude
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OrderApplicationModule, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { api } from "../../auth.js";
-->

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderRef = z.object({ id: z.uuidv7() });

export const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: z.object({ id: z.string() }) },
      CONFLICT: { data: orderRef },
    }),
});
```

**`router.ts`** — one function per procedure, typed by the contract. Every
domain failure becomes a status code here, and nowhere else.

```ts
import { P } from "unthrown";

export const ordersRouter = api.HttpRouter(ordersContract)(
  { place: PlaceOrder },
  {
    sync: ({ place }) => ({
      place: ({ errors, context }, input) =>
        place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map((order) => ({ id: order.id, quantity: order.quantity }))
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (e) =>
                errors.INVALID_QUANTITY({
                  message: e.message,
                  data: { id: e.id },
                }),
              )
              .with(P.tag("InvalidOrderId"), (e) =>
                errors.BAD_REQUEST({ message: e.message, data: { id: e.id } }),
              )
              .with(P.tag("DuplicateOrder"), (e) =>
                errors.CONFLICT({ message: e.message, data: { id: e.id } }),
              ),
          ),
    }),
  },
);
```

Add a fourth error to the contract and this stops compiling until you handle
it. That is the whole idea.

**`module.ts`** — the composition root. What the application is made of.

```ts
import { HttpModule } from "@btravstack/http-server";

export const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability(),
    otel(),
  ],
});
```

**`main.ts`** — the entry point.

```ts
import { runMain } from "@btravstack/core";

await runMain(OrdersApi);
```

That is the whole process. `PORT` and `HOST` are read inside the graph through
a configuration provider — nothing here touches `process.env` — and the
runtime is a service of the module rather than an argument to a factory.

## How it compares

|                      | btravstack      | NestJS                | AdonisJS              | Hand-rolled       |
| -------------------- | --------------- | --------------------- | --------------------- | ----------------- |
| Wiring checked       | at compile time | at boot               | at boot               | never             |
| Dependency injection | plain values    | decorators + metadata | decorators + metadata | by hand           |
| Errors               | values, typed   | exceptions + filters  | exceptions + handlers | your choice       |
| Graceful shutdown    | default         | opt-in hooks          | opt-in hooks          | write it yourself |
| Ecosystem            | small, growing  | very large            | large                 | none              |
| Full-stack           | no              | no                    | yes                   | —                 |

**NestJS has far more packages, integrations and hiring pool**, and decorators
are more concise to write. If that trade matters more than compile-time
certainty, Nest is the better tool — its own comparison page
[says so in detail](/explanation/coming-from-nestjs).

btravstack is for teams that already chose TypeScript for the type safety and
want the framework to honour that choice rather than opt out of it.

## Where to start

- **[Getting started](/tutorial/getting-started)** — a running API in five steps.
- **[Why btravstack?](/explanation/why-btravstack)** — the design argument, and what it is not.
- **[Coming from NestJS](/explanation/coming-from-nestjs)** — a side-by-side, including what Nest does better.
- **[Packages and install](/reference/packages)** — the thirteen packages and one install command per kind of deployment.

<CompileErrorDemo />
