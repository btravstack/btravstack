---
title: "@btravstack/outbox"
description: The complete surface of @btravstack/outbox — outbox(), the OutboxStore and OutboxPublisher ports, the table it reads, the per-tenant claim and what it guarantees across replicas, the lag health check, the memory and Prisma 8 stores, and OUTBOX_*.
---

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { HealthChecks, runHealthChecks } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { OutboxPublisher, OutboxStore, memoryOutboxStore, outbox } from "@btravstack/outbox";
import { prismaOutboxStore, type OutboxDatabase } from "@btravstack/outbox/prisma";
import { createFakeClock } from "@btravstack/testing";
import { OkAsync, TaggedError, type AsyncResult } from "unthrown";

// The stand-ins the fences below read: the application's database port, and a
// transport client of its own contract.
class OrderDatabase extends Port("ReferenceOrderDatabase")<OutboxDatabase<unknown>> {}
class Refused extends TaggedError("Refused") {}
class Broker extends Port("ReferenceBroker")<{
  readonly send: (topic: string, body: unknown) => AsyncResult<void, Refused>;
}> {}
-->

# @btravstack/outbox

> **Reference.** A complete, structured description of `@btravstack/outbox`:
> the relay that publishes the facts an application recorded in the same
> transaction as the rows they describe, the two ports it reads, the table it
> reads them from, and what its claim guarantees when several replicas run it.

## What is yours, and what is the relay's

The transactional outbox has two halves. **The write is yours**: the business
row and its outbox row commit in one transaction, spelled by your adapter at
the call — the framework never opens a transaction around a unit. **The relay
is this package's**: reading what is pending, publishing it in outbox order, marking
it published, backing off, and making replicas take turns on a tenant rather
than race for its rows.

Between the two sit the two ports the relay needs and cannot provide itself:

| Port              | What it answers                                                                            | Who provides it                                               |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `OutboxStore`     | `pending(tenantId, limit)`, `oldestPending(tenantIds)` and `claim(tenantId, limit, relay)` | `prismaOutboxStore`, `memoryOutboxStore`, or your own adapter |
| `OutboxPublisher` | `publish(message)` → `AsyncResult<void, PublishRefused>` — any tagged error                | you: the transport, the contract and the payload's decoding   |

```ts
export const store = Provider(OutboxStore)({
  inject: { db: OrderDatabase },
  sync: ({ db }) => prismaOutboxStore(db, { schema: "orders" }),
});

export const publisher = Provider(OutboxPublisher)({
  inject: { broker: Broker },
  sync: ({ broker }) => ({
    publish: (message) =>
      broker.send(`${message.kind}.changed`, {
        // The key a subscriber deduplicates a re-delivery on.
        eventId: message.id,
        tenantId: message.tenantId,
        id: message.subjectId,
        occurredAt: message.occurredAt.toISOString(),
        payload: message.payload,
      }),
  }),
});
```

A message is the row, as the relay reads it:

| Field        | What it is                                                                         |
| ------------ | ---------------------------------------------------------------------------------- |
| `id`         | the outbox sequence — the order a tenant's facts are published in                  |
| `tenantId`   | whose fact it is, and the unit the relay claims by                                 |
| `kind`       | which sort of thing changed                                                        |
| `subjectId`  | which one, and the key a reader compacts on                                        |
| `payload`    | your own encoding, handed to the publisher untouched — `null` is the **tombstone** |
| `occurredAt` | when the row was written, as a `Date`                                              |

## `outbox(options)`

```ts
export const Relay = Module("Relay")({
  // What the two providers read, supplied by the root that imports this.
  needs: [OrderDatabase, Broker],
  imports: [outbox({ maxLagMs: 30_000 })],
  provides: [store, publisher],
  exports: [HealthChecks],
});
```

The module **needs** `OutboxStore`, `OutboxPublisher` and `Env`, and exports
`HealthChecks`. The relay itself is a resourceful provider nothing resolves:
it starts as the graph builds — before the runtime accepts anything — and
stops when the application scope closes, after the runtime has drained and
before anything it depends on is released.

| Option     | Variable            | Default                    | What it is                                                         |
| ---------- | ------------------- | -------------------------- | ------------------------------------------------------------------ |
| `tenants`  | `OUTBOX_TENANTS`    | none                       | the tenants this relay serves, comma-separated — required          |
| `pollMs`   | `OUTBOX_POLL_MS`    | `200`                      | the sleep between sweeps that found nothing to do, `1` to `60_000` |
| `maxLagMs` | `OUTBOX_MAX_LAG_MS` | `60_000`                   | the oldest pending age the health check tolerates                  |
| `clock`    | —                   | the kernel's `systemClock` | what the poll sleeps on and the lag is measured against            |

Each option **pins** its variable: given, the variable is not read. A blank or
malformed value is a `ConfigInvalid` naming the variable, so the process exits
`78` before anything is published.

**`OUTBOX_TENANTS` has no default, deliberately.** The relay runs outside any
unit, so there is no tenant to read off anything, and "whatever is in the
table" is how one deployment starts broadcasting another's facts off a shared
database. Naming them is also how relays are sharded. A single-tenant
application names its one. A boot's typed `env` requires it too, unless
`tenants` is pinned at the call.

## The loop

Each tenant has its own loop and claims at most 32 of its oldest pending
messages per sweep. A pending claim or publish for one tenant does not stop
another tenant's loop:

- **They are published in outbox order, and a refusal stops the batch.** An
  `Err` from `publish` — or a defect — leaves that message and everything after
  it pending, because publishing the rest would let a later fact about a
  subject overtake the one still waiting.
- **Each tenant keeps its own schedule.** A failed sweep backs that tenant off,
  doubling from `pollMs` up to 30 seconds, and a clean one resets it; a full
  batch makes it due again at once, so a backlog drains at the publisher's
  speed rather than 32 messages per poll. One tenant's refused or pending
  message slows no other tenant.
- **The sleep is the `clock`'s, aborted on stop**, so `release` returns as soon
  as the batch in flight has, an idle relay never holds the process open, and
  a test drives the loop with `createFakeClock`:

```ts
const clock = createFakeClock();
const memory = memoryOutboxStore(clock);
memory.append({ tenantId: "acme", kind: "order", subjectId: "o-1", payload: null });

const Tested = Module("Tested")({
  imports: [outbox({ tenants: ["acme"], clock })],
  provides: [
    Provider(Env)({ inject: {}, value: {} }),
    Provider(OutboxStore)({ inject: {}, value: memory }),
    Provider(OutboxPublisher)({ inject: {}, value: { publish: () => OkAsync() } }),
  ],
  exports: [HealthChecks],
});

export const swept = Module.scoped(Tested, () =>
  clock.advance(0).flatMap(() => memory.pending("acme", 10)),
);
```

## The claim, and what it guarantees

**Delivery is at-least-once.** A relay that crashes between a publish and the
commit of its mark publishes that message again on the next claim, and so does
a relay whose claiming session the database ends mid-batch, so a subscriber
must tolerate a repeat. **Put the message's `id` on the wire and
deduplicate on it**: it is the one value that names a single fact. `subjectId`
names a subject with many facts, and `occurredAt` is shared by every fact one
transaction writes at one `now()`.

**What the claim rules out is the other source of repeats: replicas racing.**
One relay holds a tenant **while its claiming session lives**, and every other
relay that reaches the tenant meanwhile **skips it** rather than waiting. So:

- N replicas sweeping one table take turns rather than race for a tenant's
  rows — the duplicate rate does not grow with the replica count, and a repeat
  comes only from a lost session or a crash, deduplicated like any other;
- no two batches of one tenant are ever in flight together, so a tenant's
  committed facts go out in outbox order;
- throughput scales across tenants, not within one.

**Outbox order is not commit order.** An id is allocated when the row is
inserted, so a transaction can hold id 1 open while another commits id 2; the
relay sees only id 2, and publishes it first. No claim can order a row nobody
can see yet. Per-subject order holds where the subject's writes conflict on
the subject's own row and the outbox row is written **after** the statement
that takes it — the second writer cannot take its outbox id until the first
has committed. Write a create's outbox row after the insert, and a tombstone
after the delete; that is how the example's repository is spelled.

`claim(tenantId, limit, relay)` is that contract, and it is what an adapter of
your own must keep: claim the tenant or skip it, hand the batch to `relay`,
mark published exactly the ids `relay` answers, and release the claim — marking
nothing if `relay` defects.

## `prismaOutboxStore(db, { schema?, table?, columns?, tenantSetting? })`

From `@btravstack/outbox/prisma`, which is the only entry point that needs
`@prisma/orm-postgres`. It takes your Prisma 8 client — anything with the raw
lane and `transaction` — and reads the table in raw SQL:

| Option          | Default         | What it is                                                                                |
| --------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `schema`        | `public`        | the namespace your model is declared in                                                   |
| `table`         | `outboxMessage` | the table Prisma maps the model to — a model named `OutboxMessage`                        |
| `columns`       | the field names | each column's physical name, for a model mapped with `@map` (`{ tenantId: "tenant_id" }`) |
| `tenantSetting` | `app.tenant_id` | the run-time setting each tenant's reads and marks are pinned to, which a policy reads    |

**Every claim pins its tenant before it reads.** The claim's first statement
takes the lock, lifts the idle timeout and runs `set_config(tenantSetting,
tenant, true)` — transaction-local, as `@btravstack/prisma/rls`'s
`tenantPinned` is — so a row-level-security policy reading
`current_setting('app.tenant_id', true)` admits that tenant's rows to the read
and the mark, and no connection goes back to the pool still pinned. A
`pending` read pins the same way, and the health check pins once per tenant on
one connection, since no single statement can see two tenants under a policy.
On a table without row security the pin changes nothing.

**The claim is `pg_try_advisory_xact_lock`, per tenant, taken by the
transaction that reads, publishes and marks the batch.** A relay that does not
get the lock skips the tenant. The lock dies with the transaction, so a relay
that crashes frees it with its connection, and a mark that never commits
leaves its rows pending rather than lost. A relay can hold one pooled
connection per active tenant for the length of that tenant's batch. The pool
needs capacity for concurrent claims; a pool exhausted by stalled publishers
still makes other tenants wait for a connection.

**The claim lifts `idle_in_transaction_session_timeout` for its own
transaction**, since it sits idle while the publisher works and a configured
timeout would otherwise end the session — and free the lock — mid-batch. A
session ended any other way (a terminated backend, a failover) still frees the
lock while the relay publishes, and another relay may then publish the same
rows: that is the "while its claiming session lives" above, and the reason to
deduplicate on the id.

### The table

Declare the model in your own contract — Prisma 8 has no way for a package to
contribute one — beside the rows whose facts it records, and plan the
migration as you would any other:

```prisma
namespace orders {
  model OutboxMessage {
    id          BigInt             @id @default(autoincrement())
    tenantId    String
    kind        String
    subjectId   String
    payload     String?
    occurredAt  TimestamptzString  @default(now())
    publishedAt TimestamptzString?
  }
}
```

`occurredAt` is read through `to_json`, so `Timestamptz` works as well as
`TimestamptzString`.

**Row security is supported, and opted into in the contract alone.** Every
read and mark the store issues is pinned to its tenant, so the model may carry
`@@rls` with the same policy your tenant-owned models have:

```prisma
  model OutboxMessage {
    // … the fields above …
    @@rls
  }

  policy_all outbox_tenant_isolation {
    target    = OutboxMessage
    using     = "\"tenantId\" = current_setting('app.tenant_id', true)"
    withCheck = "\"tenantId\" = current_setting('app.tenant_id', true)"
  }
```

Adopting it on an existing table is that edit, then `prisma migration plan` and
`db migrate` like any change — the plan is `ENABLE ROW LEVEL SECURITY` and
`CREATE POLICY`, both additive. Three things must already hold, and each fails
quietly if it does not: every writer of the table writes inside a pinned
transaction (the row your adapter writes beside the business row already is,
if that transaction is `tenantPinned`); the relay connects as a role that owns
nothing and is `NOBYPASSRLS` — Prisma 8 cannot express `FORCE`, so the owner
bypasses the policy; and the policy reads the setting `tenantSetting` names. A
relay whose policy reads a different setting is handed nothing and reports
nothing pending, which looks exactly like an empty outbox.

**`id` is a `BigInt`, not an `Int`.** An `int4` sequence stops at 2^31 − 1 —
under a month at a thousand facts a second. The store reads it through
`pg/int8@1` and hands the port a `number`, refusing as a defect an id past
2^53 (some 285,000 years at that rate) rather than rounding it onto another
row's. A table created with an `Int` id needs its column **and** its sequence
widened: `ALTER COLUMN … TYPE int8` leaves a `SERIAL`'s sequence `AS integer`,
still stopping at 2^31 − 1, which is why the example's widening migration
alters the sequence beside the column.

Writing a row is your adapter's, inside the transaction it already opens:

<!-- doctest: skip — a model's ORM accessor is typed by the application's emitted contract, which this page does not have -->

```ts
await tx.orm.orders.OutboxMessage.create({
  tenantId,
  kind: "order",
  subjectId: order.id,
  payload: JSON.stringify({ quantity: order.quantity }),
});
```

The store's queries filter on `tenantId` and `publishedAt IS NULL` and order by
`id`; an index for that, and the `DELETE` that prunes published rows, are your
migration's and your housekeeping's.

## `memoryOutboxStore(clock?)`

The in-process store, for tests and for in-memory adapters. `append(message)`
is its write half — there is no transaction to write inside — stamping the next
id and the clock's time; the claim is a per-tenant flag, so two relays over one
instance behave as two replicas over one table do.

## The health check

`outbox()` contributes one member to `HealthChecks`, named `outbox`: it reads
every tenant's oldest pending time in **one** `oldestPending` call, on one
connection — never a connection per tenant, which would queue the pool behind
the probe — and
reports **unhealthy, naming every tenant that is behind**, once that time is
older than `maxLagMs`. It
reports lag rather than reachability because the failure an operator needs to
see is a publisher refusing one message forever — the store answers, the
table is fine, and one tenant's outbox has stopped moving. Like every health
check here it is `/healthz`'s and never gates `/readyz`.

```ts
export const report = Module.scoped(Tested, (ctx) => runHealthChecks(ctx.get(HealthChecks)));
```

## What it reports

Every claim and every publish is an `Observers` operation; the module holds no
logger. With `@btravstack/observability` composed:

| Signal   | Name                                                            | Attributes                                                                          |
| -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| span     | `outbox.publish`                                                | `kind`, `btravstack.tenant_id`, `btravstack.outbox.id`, `btravstack.outbox.subject` |
| counter  | `btravstack.outbox.operations`                                  | `{ operation, kind?, btravstack.tenant_id, outcome }` — `publish` or `claim`        |
| log line | `"outbox.publish failed"` / `"outbox.claim failed"`, at `error` | the attributes and details, with the failure as the cause                           |

A claim opens **no span** — one per tenant per poll would bury the publishes —
and a success writes no line. The tenant is a dimension because the relay is
told its tenants, so it is bounded; the id and subject are details, on the span
and the error line only.

## What it deliberately does not do

- **Exactly-once.** No outbox can, without the broker joining the database's
  transaction.
- **Choose a transport.** `OutboxPublisher` is the seam; an AMQP client, a
  webhook and a Kafka producer are three providers of it.
- **Write the row.** The transaction is your adapter's, by the rule that keeps
  commit boundaries off the unit.
- **Retention, or a second store.** Published rows stay until your housekeeping
  prunes them; `@btravstack/prisma` is the only persistence starter, and this
  store is the only one shipped over it.
