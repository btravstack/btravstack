# AGENTS.md — @btravstack/outbox

The transactional outbox's relay: the loop that reads committed facts out of a
table and publishes them, the claim that keeps replicas from publishing the
same one, and the table shape it reads. The root `AGENTS.md` is the
authoritative spec; thesis #2 is why this package exists — the outbox plus a
saga is this stack's answer to cross-store atomicity, so the half of it every
application would otherwise copy is a framework concern.

## Public surface

The exports are `src/index.ts` and `src/prisma.ts` (`@btravstack/outbox/prisma`),
each with its TSDoc; `docs/reference/outbox.md` is the reader's page.

## What is the application's, and stays so

- **The write.** The business row and its outbox row commit in ONE
  transaction, and that transaction is the adapter's, spelled at the call
  (thesis #2). There is no `append` port for a Prisma application: the row is
  written with the application's own ORM, inside the transaction it already
  opens, and a port would have to reach into that transaction to be any use.
  `memoryOutboxStore().append` exists because an in-process store has no
  transaction to write inside.
- **What "publish" means.** `OutboxPublisher` is a port the application
  provides — the transport, the contract and the payload's decoding are all
  its own. That is what keeps the relay transport-neutral: an AMQP publisher,
  an HTTP webhook and a Kafka producer are three providers of one port, and the
  loop above them does not change.
- **The table, declared in the application's contract.** Prisma 8 has no way
  for a package to contribute a model, and a client is typed by the
  application's emitted contract anyway (`@btravstack/prisma`'s `client`
  argument says why). So the shape is documented — `docs/reference/outbox.md`
  carries the PSL block — and `prismaOutboxStore` reads it in raw SQL.

## The claim is per tenant, and that is a choice of three

Three shapes were on the table, and the one shipped is the only one that keeps
both promises at once:

1. **`FOR UPDATE SKIP LOCKED` on rows** stops two replicas taking one row, and
   lets them take a tenant's rows 1–32 and 33–64 at the same moment — so the
   second batch can reach the broker first, and a subject's tombstone can
   overtake its create.
2. **A lease column** (`claimedUntil`) has the same reordering, adds a
   migration, and duplicates the moment a batch publishes slower than the
   lease is long.
3. **A per-tenant advisory lock, held by the claiming transaction** — what
   ships. `pg_try_advisory_xact_lock(hashtext(table), hashtext(tenant))`: a
   relay that does not get it skips the tenant rather than waiting, and the
   lock dies with the transaction, so a crashed relay frees it with its
   connection. One tenant is published by one relay at a time, so no two
   batches of one tenant are ever in flight together, and throughput scales
   across tenants.

## What the claim orders, and what it cannot

**The claim orders what is visible; it cannot order what has not committed.**
An outbox id is allocated when the row is inserted, not when its transaction
commits, so transaction A can hold id 1 open while B commits id 2 — and the
relay, seeing only id 2, publishes it first (`prisma-outbox.spec.ts`, "publishes
what has committed, so a lower id still in flight goes out after a higher one",
pins exactly that). The guarantee is therefore: a tenant's committed facts go
out in outbox order, one relay at a time — never outbox order as a promise of
commit order.

**Per-subject order rests on the subject's own row**, and that is where it
belongs: two writes about one subject conflict on that subject's business
row, so the second cannot take its outbox id until the first has committed,
provided the outbox row is written AFTER the statement that takes the row.
`prismaOrderRepository` is spelled that way — `create` then the outbox row;
`delete` then the tombstone, which cannot even see a create that has not
committed. A write that inserts its outbox row first gives this up.

**Coordinating writers with the relay was measured against this and
declined.** The shape: every writer takes `pg_advisory_xact_lock_shared` on the
relay's (table, tenant) key, and the relay takes the exclusive key briefly to
read a watermark below which nothing is in flight. A blocking barrier queues
every new writer of the tenant behind the oldest in-flight write, so one
transaction left idle turns into a tenant-wide write outage; a non-blocking
one never fires for a tenant written continuously, and the relay starves. And
every writer of the table must remember the lock — one that forgets silently
reopens the gap — which is a burden on the very transaction thesis #2 leaves
to the adapter. Per-subject order through the business row costs nothing and
cannot be forgotten by a writer that writes the row.

**A subscriber deduplicates on the outbox id**, which the publisher must put
on the wire — `examples/order-amqp-worker` sends it as `eventId`. Neither the
subject (many facts per subject) nor `occurredAt` (every fact one transaction
writes shares one `now()`) names a single fact.

The two-key form namespaces by table, so two outbox tables never contend and
a lock some other code takes on a single bigint never collides. A `hashtext`
collision between two tenants only serialises them.

**The cost is stated, not hidden**: the claim, the publishes and the mark run
in one transaction, so a relay holds one pooled connection per active tenant
for that tenant's batch. A deployment's pool needs room for concurrent claims;
if all its connections are pinned by stalled publishers, other tenants wait at
the pool. That is an interactive transaction — the shape thesis #2 refuses for
a unit — and it is accepted here because concurrency is bounded by the
configured tenants and each 32-message batch, rather than by requests.

**One relay per tenant holds while its claiming session lives, and no
longer.** The lock is the session's: if the database ends that session
mid-batch, the lock is freed while the relay is still publishing, and another
relay can claim the same unmarked rows. The configurable case is closed — the
claim sets `idle_in_transaction_session_timeout` to `0` for its own
transaction (`set_config(…, true)`, a user-settable parameter), since the
transaction sits idle while the publisher works; `prisma-outbox.spec.ts`'s
"keeps its claim through a publish slower than the server's
idle-in-transaction timeout" runs a pool whose sessions time out at 200 ms and
fails without it. The lift is the claim's first statement, so the timeout
still runs between `BEGIN` and it — and a fresh Prisma 8 client's first query
verifies its contract marker there, over a second connection. A timeout
shorter than that ends the session before the lock is taken: the sweep fails
and backs off, and nothing is published twice. That spec's fixture issues one
query outside a transaction first, for exactly this reason. The rest — a
terminated backend, a failover — is delivery
being at-least-once, which the outbox id deduplicates. Probing the session's
liveness between publishes was declined: it narrows the window without
closing it, at a round trip per message.

**The id is a `BigInt`.** An `int4` sequence ends at 2^31 − 1, under a month at
a thousand facts a second; `int8` read as a JS number is exact to 2^53, past
which the store defects rather than round an id onto a neighbour's — a
rounded id would be marked, and deduplicated on, as some other row. Widening
an existing table takes the column and its `SERIAL` sequence both, which is
why the example's migration alters the sequence too.

**Measured, against the shared PostgreSQL** (`examples/order-infrastructure`'s
`prisma-outbox.spec.ts`, "publishes every message exactly once across four
racing relays"): four relays sweeping one tenant in batches of four published
48 messages exactly 48 times, in write order. With the lock check disabled the
same spec published them 132 times.

## The loop

- **A refused publish stops the tenant's batch.** Publishing the rest would
  let a later fact overtake the refused one. The price is head-of-line
  blocking — a message the publisher refuses forever holds its tenant — which
  is what the health check exists to surface: `outbox` reports unhealthy,
  naming the tenant, once its oldest pending message is older than
  `maxLagMs`.
- **Each tenant keeps its own clock.** After a failed sweep its back-off
  doubles from the poll interval to 30 s and resets on a clean one; after a
  full batch it is due again at once, so a backlog drains at the publisher's
  speed rather than 32 per poll; when idle it waits `pollMs`. One counter for
  the whole sweep was the first shape, and it let one tenant's poison message
  hold every other tenant to its back-off. Each tenant has its own loop, so a
  pending claim or publish holds that tenant alone; one loop for all tenants
  left later tenants waiting for the first pending publisher.
- **The health check is one round trip** — `OutboxStore.oldestPending` over
  every tenant at once. A read per tenant per `/healthz` queues the pool behind
  the probe that is meant to report it, and outlives the kernel's health
  deadline with queries nothing can cancel.
- **The sleep is the kernel's `Clock`**, aborted by the relay's own stop
  signal, so `release` returns as soon as the in-flight batch has, an idle
  relay pins nothing (`systemClock`'s timer is unref'ed), and a spec drives the
  loop with `createFakeClock`. There is no `Clock` PORT in the kernel, so the
  clock is an option rather than an injection.
- **Started by `acquire`, stopped by `release`** — so it publishes before the
  runtime accepts anything, and is stopped after the runtime has drained and
  before anything it depends on (the publisher's client) is released, which is
  di's reverse-acquisition order and no code of this package's.
- **No logger.** A claim and a publish are each an `Observers` operation; the
  claim is `traced: false`, since a span per tenant per poll would bury the
  publishes. The tenant is an attribute — the relay is told its tenants, so it
  is bounded — and the outbox id and subject are details.

## Why tenants are configuration

The relay runs outside any unit, so there is no tenant to read off anything,
and sweeping "whatever is in the table" is how one deployment broadcasts
another's facts. `OUTBOX_TENANTS` has no default for that reason, and naming
them is also how relays are sharded. A single-tenant application names one.

## Deliberately not here

- **Exactly-once.** A crash between a publish and its mark re-publishes; a
  subscriber dedupes on the outbox id. No outbox can do better without the
  broker joining the database's transaction.
- **A second store adapter.** `OutboxStore` is three methods, and the reasons
  `@btravstack/prisma` is the only persistence starter (root **Persistence**)
  hold here too.
- **Retention.** Published rows stay. Deleting them is an operational choice —
  some teams keep the log — and the `DELETE` that prunes them belongs to
  whoever owns the database's housekeeping.
- **A partial index.** The store's queries filter on `tenantId` and
  `publishedAt IS NULL` and order by `id`; an index for that is the
  application's migration, sized by its own table.
