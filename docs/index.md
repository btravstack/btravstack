---
layout: home
title: start — the application kernel for TypeScript
description: Boot a dependency-injection module into a running process — HTTP, Temporal or AMQP — with wiring proven at compile time, a drain that survives Kubernetes, and nothing that throws.

hero:
  name: "start"
  text: "The application kernel for TypeScript"
  tagline: Boot one proven module into one runtime, drain in-flight work on SIGTERM, and close every scope on every path — with the wiring checked before the process exists.
  actions:
    - theme: brand
      text: Get Started
      link: /tutorial/getting-started
    - theme: alt
      text: Why start?
      link: /explanation/why-start
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/start

features:
  - title: One process, one runtime
    details: An API, a Temporal worker and an AMQP consumer are three processes booting the same module under a different composition root. The runtime is a service of the module, and a graph holds exactly one.
  - title: Wiring proven at compile time
    details: A module that forgets a provider, a runtime whose needs are not exported, a root with no runtime — each is an arity error at the call site, before anything runs. That is @btravstack/di, and start builds on it.
  - title: A drain that survives Kubernetes
    details: SIGTERM flips readiness, waits for endpoint removal to catch up, then stops accepting and gives in-flight work a deadline. Whatever is still open is reported abandoned, not lost silently.
  - title: Nothing throws
    details: Every async surface is an unthrown AsyncResult, the startup error channel is the application's own, and the process exit code is decided in exactly one place — runMain.
---

## At a glance

`examples/order-api`'s **orders slice**, served on its own and condensed to one
procedure: a contract, a router that is a provider, a composition root, and one
call. The example itself composes that slice and a `customers` one into a
single router through
[controllers](/how-to/split-a-router-into-controllers).

```ts
import { runMain } from "@btravstack/core";
import { HttpModule, HttpRouter } from "@btravstack/http";
import { oc, type } from "@orpc/contract";
import { P } from "unthrown";

import { ApplicationModule, PlaceOrder } from "./application.js";
import { PersistenceModule } from "./persistence.js";

// The contract comes first; a client can take it without the server.
const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<{ readonly id: string; readonly quantity: number }>())
    .errors({
      INVALID_QUANTITY: { data: type<{ readonly id: string }>() },
      CONFLICT: { data: type<{ readonly id: string }>() },
    }),
};

// The router is a provider: it declares the use case its procedure calls.
// Every domain error is named here — the one place a Result becomes HTTP.
const ordersRouter = HttpRouter(ordersContract)([PlaceOrder], {
  sync: (place) => ({
    place: ({ errors }, input) =>
      place
        .execute(input.id, input.quantity)
        .map((order) => ({ id: order.id, quantity: order.quantity }))
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              errors.INVALID_QUANTITY({
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
});

// The composition root. The runtime is a service of this module.
const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [ApplicationModule, PersistenceModule],
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

**SIGTERM drains in three beats.** Readiness flips false; the kernel waits for
Kubernetes to stop routing to the pod _before_ telling the runtime to stop
accepting; then in-flight requests get a deadline, and whatever is still open
is aborted and reported `abandoned` in the [exit report](/reference/core/exit-report).
Beat two is the whole point — see [Draining, in three beats](/explanation/draining-in-three-beats).

## Packages

Eight packages, one dependency direction — `core` → `config` → `di`, every
starter on top of `core`, and a test harness beside them. Details and install
lines in [Packages and install](/reference/packages).

- **`@btravstack/di`** — the container: `Port`, `Provider`, `Module`, `Context`.
  Proves the wiring before the process exists.
- **`@btravstack/config`** — configuration from the environment, as providers:
  `Config.object`, `Config.provider`, the `Env` port, `ConfigInvalid`.
- **`@btravstack/core`** — the kernel: `start`, `runMain`, the lifecycle state
  machine, the unit registry and the `Runtime` contract.
- **`@btravstack/observability`** — logging, as a starter: a strict `Logger`
  port stamped with the ambient unit's trace id, a dependency-free JSON sink,
  pino behind a subpath, and the kernel's own events as lines in the same
  stream. Traces and metrics are not here yet.
- **`@btravstack/http`** — the HTTP starter: an oRPC contract served over
  `node:http`, one unit per request, `HttpRouter` and `HttpModule`.
- **`@btravstack/temporal`** — the Temporal worker starter: one unit per
  activity attempt, `TemporalActivities` and `TemporalModule`.
- **`@btravstack/amqp`** — the AMQP consumer starter: one unit per message,
  `AmqpHandlers` and `AmqpModule`.
- **`@btravstack/testing`** — the test harness, a dev dependency:
  `bootFixture` boots and stops applications inside a vitest fixture,
  `tapped` reaches a service of the running graph, `testRuntime` and
  `createFakeClock` stand in for a transport and a clock.
