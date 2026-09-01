---
title: Modules and privacy
description: The built container is one flat map at runtime — module privacy is the type system withholding names, and why that is both enough and the point.
---

<!-- doctest: prelude
import { Module, Port, Provider, type Context } from "@btravstack/di";
import { Config, Env } from "@btravstack/config";
import type { AsyncResult } from "unthrown";
type Order = { readonly id: string };
class OrderRepository extends Port("OrderRepository")<{
  readonly find: (id: string) => AsyncResult<Order, never>;
}> {}
class Pool extends Port("Pool")<{ readonly close: () => void }> {}
declare const ctx: Context<OrderRepository>;
class Logger extends Port("Logger")<{
  readonly info: (message: string) => void;
}> {}
const orderAudit = Provider(
  Port("OrderAudit")<{ readonly record: () => void }>,
)({
  inject: { logger: Logger },
  sync: ({ logger }) => ({ record: () => logger.info("audited") }),
});
class OrderDatabase extends Port("OrderDatabase")<{
  readonly query: () => void;
}> {}
class Outbox extends Port("Outbox")<{ readonly push: () => void }> {}
const databaseConfig = Config.provider("DatabaseConfig")(
  Config.object({ url: Config.string("DATABASE_URL") }),
);
const orderDatabaseProvider = Provider(OrderDatabase)({
  inject: { config: databaseConfig.port },
  sync: () => ({ query: () => {} }),
});
const orderRepositoryProvider = Provider(OrderRepository)({
  inject: { db: OrderDatabase },
  sync: () => ({ find: () => undefined as never }),
});
const outboxProvider = Provider(Outbox)({
  inject: { db: OrderDatabase },
  sync: () => ({ push: () => {} }),
});
-->

# Modules and privacy

> **Explanation.** This page explains what enforces a module's `exports`
> boundary, and why the honest answer — nothing, at runtime — is the design
> rather than a gap. For the task, see
> [Keep a port private](/how-to/keep-a-port-private); for the surface,
> [Modules](/reference/di/modules).

A module's `exports` list promises that its internals — the pool behind the
repository, the parsed config behind the client — cannot be reached from
outside. This page is about what enforces that promise, because the honest
answer is surprising: at runtime, nothing does.

## The flat map

Build any module tree and the result is a single map from port id to service.
`Persistence`'s private `Pool` is in it, right next to the exported
`OrderRepository` — there is nowhere else to put it; the repository's own
construction had to read it. No nested containers, no per-module resolution
scopes, no hierarchy to walk at `get` time.

Runtime enforcement would mean wrapping that map per module boundary —
tracking, for every caller, which module's vantage point it holds. That is a
real design (nested injectors exist in other containers), and it buys real
costs: resolution walks a chain, module boundaries exist as objects with
lifetimes of their own, and the failure mode is a **runtime** "not visible
from here" — precisely the class of surprise this container exists to remove.

## Privacy is a missing name

`di` enforces the boundary one level earlier. The built `Context<X>` is typed
by the module's `Exports` channel, and `ctx.get` only accepts ports in `X`:

```ts
ctx.get(OrderRepository); // exported — compiles
// @ts-expect-error — Pool is not in X: the context's channel holds only the exports
ctx.get(Pool); // does not compile — Pool is not in X
```

The `Pool` service is present in the map; the **type that would let you ask
for it** is not in scope. The same withholding governs wiring: a provider in
`App` cannot list `Pool` in its `inject`, because what `App` can see — its own
provides, its imports' exports — does not include it, and the dependency would
surface as [`UNSATISFIED DEPENDENCIES`](/explanation/compile-time-wiring) at
the entry point. Privacy and dependency-checking are one mechanism, not two.

This is privacy in exactly the sense TypeScript itself uses everywhere else:
`#private` fields aside, an unexported type, a module-private symbol, an
`internal` API are all names withheld rather than bytes hidden. `di` extends
the convention to wiring.

## A need is declared, never absorbed

The same computation answers a question NestJS answers differently. There, a
provider sees only what its own module declares or imports, and a need nothing
local satisfies is an error where it is written — which is why NestJS also
needs `@Global`, a way for a cross-cutting module to be visible without being
imported.

`di` splits that differently. A module may be handed a port by whoever composes
it — but only one **its own providers asked for by name**:

```ts
export const AuditSlice = Module("AuditSlice")({
  needs: [Logger],
  provides: [orderAudit],
  exports: [orderAudit],
});
```

The provider may depend on that `Logger` and will be handed whatever an ancestor
supplies. What `needs` does **not** do is provide the port here: it stays
outside what the module can see, so it cannot be exported, and it manufactures
no obligation for a root that owes nothing. It says: _the provider in this
module depends on a `Logger` it does not build, and something above it has to_. Leave it out and the module does not compile at all — the diagnostic
names the port — so a slice can never quietly absorb whatever the composition
root happens to be holding.

**An import's needs travel on their own.** A module that merely imports
`AuditSlice` does not restate `Logger`: the obligation is already in
`AuditSlice`'s type, at the `imports` entry a reader is looking at, and the
[entry point](/reference/di/entry-points) still refuses a root that has not
discharged it. Restating it at every level would put one line on every module
between the reader of a port and the root that supplies it — for `Env`, that
was six declarations in the order API and only one of them a module that reads
an environment variable.

So the declaration lands where the feature is:

```ts
// reads DATABASE_URL — declares it
const DatabaseModule = Module("Database")({
  needs: [Env],
  provides: [databaseConfig, orderDatabaseProvider],
  exports: [OrderDatabase],
});

// only imports it — declares nothing
export const OrderPersistenceModule = Module("OrderPersistence")({
  imports: [DatabaseModule],
  provides: [orderRepositoryProvider, outboxProvider],
  exports: [OrderRepository, Outbox],
});
```

That is NestJS's `ConfigModule.forFeature` shape without a global to reach it
through — and it is the whole difference from `@Global`. A global module is
invisible plumbing: a slice benefits from it without mentioning it, and reading
`slices/audit/` still tells you nothing. A declared need is the opposite — the
slice states the port and stays silent about the supplier, which is exactly the
pair that lets it be recomposed. The same `AuditSlice` drops into a different
root, or [lifts into a process of its own](/how-to/split-a-router-into-controllers),
with no edit: any root that answers `Logger` will do.

`Scope` is the one exemption, and it is forced rather than chosen: nothing can
provide `Scope` — a provider for it is a
[wiring defect](/reference/di/wiring-defects) — so it is never something an
ancestor supplies. `Module.scoped` and `start` discharge it by opening one.

## What it does not defend against

A determined caller can cast — `ctx as any`, a hand-rolled object with the
right `portId` — and reach anything in the map. The boundary is not a security
perimeter, and does not try to be: the threat model is **accident**, not
adversary. What it prevents is the quiet coupling where application code
starts importing an adapter's internals because they happened to be
reachable, and a year later the adapter cannot change without breaking its
callers.

Because the guarantee lives entirely in the types, its regression tests do
too: [Hexagonal (di alone)](/examples/di-hexagonal) pins "`ctx.get(Pool)`
does not compile" with a `@ts-expect-error` in a `.test-d.ts` file. A runtime
test could only prove the opposite — the flat map genuinely holds the pool —
which is true, and not the point.

## What the flat map buys in exchange

- **`get` is a map lookup.** No chain to walk, no vantage-point bookkeeping,
  no allocation per boundary.
- **One instance per provider, ever.** A diamond — two modules importing the
  same `Config` — cannot yield two configs, because de-duplication happens on
  provider identity before construction and the result lands in one map.
  Nested-container designs have to work to get this right; here it falls out.
- **Whole-module re-export is free.** `exports: [DatabaseModule]` forwards a
  type; nothing is copied or proxied at runtime.
- **The type-level model stays honest.** `Available` (what a module can see)
  and `Exports` (what it shows) are set computations over port types —
  checkable, testable, and identical in shape to what the runtime actually
  does with ids in a map.
- **The kernel needs no back door.** `start` wraps your module in one more
  that imports it, provides `Env` and re-exports it whole — so `X` stays
  exactly what you composed, and `Env` reaches every provider, and every
  per-unit fork, through the ordinary graph rather than a side channel.

The trade, stated once: `di`'s module boundary is exactly as strong as the
type system's reach, in exchange for a runtime with nothing in it to
misbehave. Where the types end — casts, duplicate ids, widening —
[pre-construction defect checks](/reference/di/wiring-defects) stand behind
them; what those catch is wiring bugs, not privacy violations, because past
the types a privacy violation is indistinguishable from intent.
