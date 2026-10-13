---
title: Share application infrastructure with units
description: Configure a logger, a configuration value or a client once, at the application root, and inject it into request and job units with no forwarding — the lifetimes, what is refused, and how to migrate a `needs`/`exports` chain.
---

# Share application infrastructure with units

> **How-to.** Register infrastructure once, at the root, and inject it where it
> is used inside a request or job unit. For what a unit is, see
> [Use request-scoped services](/how-to/use-request-scoped-services).

A unit module — what `HttpModule`'s `unit`, `AmqpModule`'s `unit` or
`TemporalModule`'s `unit` binds — is forked over the **application scope** once
per unit of work. A provider in it may inject anything the application scope
provides. Nothing has to be forwarded to make that true: what a module owes is
inferred from its providers' `inject` records, and the root discharges it by
providing the port.

## Before

<!-- doctest: skip — the forwarding shape this page replaces; it still compiles, and the fence below is what the gate holds -->

```ts
const RequestModule = Module("Request")({
  needs: [requestPolicy.port, Logger], // restates RequestService's inject
  provides: [RequestService],
  exports: [RequestService],
});

export const App = HttpModule("App")({
  router,
  unit: { anonymous: RequestModule },
  imports: [observability()],
  provides: [requestPolicy],
  exports: [requestPolicy.port, Logger], // forwarded for the unit's sake
});
```

The consumer stated its dependencies three times: in `inject`, in the unit
module's `needs`, and in the root's `exports`. The second and third drifted
whenever the first changed.

## After

Root, unit module and consumer together — the consumer's `inject` is the only
place a dependency is written:

```ts
import { Config } from "@btravstack/config";
import { Logger, runMain } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { createLogger, jsonSink, kernelEvents, observability } from "@btravstack/observability";
import { HttpModule, defineHttp } from "@btravstack/orpc-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";

// Configuration, defined beside the service that reads it. It is a provider,
// so it is parsed where it is REGISTERED — the root, below — once, at boot.
export const requestPolicy = Config.provider("RequestPolicy")(
  Config.object({ maxItems: Config.integer("APP_MAX_ITEMS", { min: 1, default: 100 }) }),
);

// The consumer: its `inject` record is the whole statement of what it needs.
export class RequestService extends Provider.class("RequestService", {
  inject: { policy: requestPolicy.port, logger: Logger },
}) {
  clamp(requested: number): number {
    const limit = Math.min(requested, this.deps.policy.maxItems);
    this.deps.logger.info("clamped", { requested, limit });
    return limit;
  }
}

// The unit module: built per request, owes `RequestPolicy | Logger` by
// inference, and writes neither down.
const RequestModule = Module("Request")({
  provides: [RequestService],
  exports: [RequestService],
});

const contract = {
  items: oc.input(z.object({ count: z.number().int() })).output(z.object({ count: z.number() })),
};
const api = defineHttp().units<{ anonymous: typeof RequestModule }>();
const router = api.OrpcRouter(contract)({
  unit: { service: RequestService },
  sync: () => ({
    items: ({ context, input }) => OkAsync({ count: context.unit.service.clamp(input.count) }),
  }),
});

// The root: the policy and the logger are registered here, once, and nothing
// is exported for the unit.
export const App = HttpModule("App")({
  router,
  unit: { anonymous: RequestModule },
  imports: [observability()],
  provides: [requestPolicy],
});

// Bootstrap logging stays outside the graph: the kernel's own events are
// observable before the container exists, during a failed boot and after
// teardown.
await runMain(App, { onEvent: kernelEvents(createLogger(jsonSink())) });
```

Forget `provides: [requestPolicy]` and `runMain(App)` does not compile; the
diagnostic ends on `"RequestPolicy"`. A module that wants its boundary checked
at its own declaration may still write `needs` — see
[Modules](/reference/di/modules#inferred-needs-and-the-declaration-gate).

## The lifetimes

| Where it is provided               | Built                    | Released                                  |
| ---------------------------------- | ------------------------ | ----------------------------------------- |
| the root (and anything it imports) | once per **running app** | once, when that app's scope closes        |
| a unit module (and its imports)    | once per **unit**        | when that unit settles, inside its record |

- **Per app, not per process.** Two applications booted side by side get their
  own logger, configuration and clients, from their own `env`.
- **Configuration fails the boot.** A config provider at the root is parsed
  before readiness, so an invalid value exits `78` even if only a unit reads
  it.
- **The logger is shared and still correlated.** `createLogger` reads the
  active unit per call, so one application-scope logger stamps each line with
  the unit that wrote it.
- **Caller state stays in the unit.** A tenant, a principal, a bearer token and
  the unit's `AbortSignal` belong to the fork. An application-scoped factory
  may build a request-bound client from them inside the unit — the order
  GraphQL gateway's `OrderReads` does, from an application-scoped origin — but
  never keeps one.

## What is refused

| Mistake                                                 | Where                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the root provides nothing for a port a unit injects     | `start` / `runMain`: `UNSATISFIED DEPENDENCIES — nothing provides`, naming the port                                                                               |
| an application provider injects a port only a unit has  | the same, naming the unit's port: the root never holds what a fork builds                                                                                         |
| a unit provider reads `Env`                             | the same, naming `UNIT READS CONFIGURATION — Env is application-scoped`; a `Config.provider` cannot sit in a unit at all, since a unit's error channel is `never` |
| a unit module provides a port the root already provides | defect: `unit module "…" of runtime "…" provides port "…", which the application scope already provides`                                                          |

The last one is a runtime check rather than a compile error. It compares the
two module trees before the runtime starts, for every unit module the runtime
lists, so a unit that would rebuild the application's client or logger never
serves one; a module forked without being listed is checked at its first fork.
A unit may still add a member to one of the application's set ports.

## Migrate an existing application

1. **Delete `needs` that restate `inject`.** In a slice or a unit module, a
   `needs` list whose ports are exactly what its providers inject is now
   redundant. Keep a list only where you want the boundary checked at the
   module itself; `needs: []` states "owes nothing".
2. **Delete root `exports` that exist only for a unit.** `Logger`, `Tracer`,
   `Meter`, a database client: a fork reads whatever the root can see. Keep
   the exports a spec reads back out of the application context, and your
   business ports.
3. **Move configuration out of unit modules.** Register the `Config.provider`
   at the root (or in a module the root imports) and inject its port in the
   unit.
4. **Remove application ports from unit modules.** If boot reports a rebuilt
   port, the unit module imports a module the root already composes — drop
   that import from the unit.
5. **Expect a root's missing port at `start`.** Starter sugars no longer run the
   declaration gate unless the root writes `needs`, so a forgotten import is
   reported once, as `UNSATISFIED DEPENDENCIES`, at the `start` or `runMain`
   call.
