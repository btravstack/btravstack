# @btravstack/outbox

> The transactional outbox relay for [`@btravstack/core`](../core): a poll loop
> that publishes committed facts in the order they were written, a per-tenant
> claim so replicas never publish the same row twice, and a Prisma 8 store.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/outbox)** ·
[API Reference](https://btravstack.github.io/btravstack/api/outbox/)

```sh
pnpm add @btravstack/outbox @btravstack/core @btravstack/config @btravstack/di unthrown
```

Four peer dependencies, plus `@prisma/orm-postgres` — optional, and needed only
if you compose the Prisma store from `@btravstack/outbox/prisma`. Node `>=22`.

## A worked example

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import type { OutboxDatabase } from "@btravstack/outbox/prisma";
import { TaggedError, type AsyncResult } from "unthrown";

// The application's own halves, declared here so this sample stands on the
// published packages alone: its database port, from `prismaDatabase`, and a
// transport client of its own contract.
class OrderDatabase extends Port("ReadmeOrderDatabase")<OutboxDatabase<unknown>> {}
class Refused extends TaggedError("Refused") {}
class Broker extends Port("ReadmeBroker")<{
  readonly send: (topic: string, body: unknown) => AsyncResult<void, Refused>;
}> {}
declare const BrokerModule: Module<Broker, never, never>;
declare const OrderPersistenceModule: Module<OrderDatabase, never, never>;
-->

The application writes its outbox row in the same transaction as the row it
describes — that stays its own. What it provides the relay is where the table
is, and what publishing a row means:

```ts
import { OutboxPublisher, OutboxStore, outbox } from "@btravstack/outbox";
import { prismaOutboxStore } from "@btravstack/outbox/prisma";

const store = Provider(OutboxStore)({
  inject: { db: OrderDatabase },
  sync: ({ db }) => prismaOutboxStore(db, { schema: "orders" }),
});

const publisher = Provider(OutboxPublisher)({
  inject: { broker: Broker },
  sync: ({ broker }) => ({
    publish: (message) =>
      broker.send(`${message.kind}.changed`, {
        tenantId: message.tenantId,
        id: message.subjectId,
        payload: message.payload === null ? null : JSON.parse(message.payload),
      }),
  }),
});

export const Relay = Module("Relay")({
  imports: [OrderPersistenceModule, BrokerModule, outbox()],
  provides: [store, publisher],
  exports: [],
});
```

## Options

| Option              | Where                        | What it is                                                                       |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `OUTBOX_TENANTS`    | environment, or `tenants`    | the tenants this relay serves, comma-separated — required                        |
| `OUTBOX_POLL_MS`    | environment, or `pollMs`     | the idle sleep between sweeps (default `200`)                                    |
| `OUTBOX_MAX_LAG_MS` | environment, or `maxLagMs`   | the oldest pending age the `outbox` health check tolerates (default 60 s)        |
| `clock`             | `outbox({ clock })`          | what the poll sleeps on and the lag is measured against (default: `systemClock`) |
| `schema`, `table`   | `prismaOutboxStore(db, {…})` | where the model lives (default `public`, `outboxMessage`)                        |

The full table — defaults, semantics, the table's PSL and the reasoning — lives
on [the reference page](https://btravstack.github.io/btravstack/reference/outbox),
which is this list's one detailed home.

## What it decides, and what it does not

**It decides** that delivery is at-least-once, that one relay publishes a
tenant at a time — so N replicas never publish one row twice at once, and a
tenant's facts keep their order — that a refused publish stops its tenant's
batch and backs off, and that a tenant falling behind is unhealthy on
`/healthz`.

**It does not decide** what a publish is, which transport it rides or how the
payload is encoded — that is your `OutboxPublisher` — nor the transaction that
writes the row, which is your adapter's. There is no exactly-once, no
retention and no second store; the reasons are in [`AGENTS.md`](./AGENTS.md).

## License

MIT
