# `@btravstack/core` example: the order broadcast worker

**What AMQP is for: telling everyone what happened.** This deployment
broadcasts a **change stream** — every write to an order, as a fact on the
wire — and it gets those facts out without ever letting "the order committed"
and "the event was sent" disagree: the **transactional outbox** pattern, end
to end.
The consuming half is served by
[`@btravstack/amqp`](../../packages/amqp) the way `order-api` is
served by `@btravstack/http`; the contract lives in
[`order-amqp-contract`](../order-amqp-contract), because another service
binding its own queue to the `orders` exchange needs it and needs none of this.

```
src/slices/notifications/handler.ts   the notifier: orderNotifications, one piece on the "orderNotifications" consumer, built by AmqpHandler from Logger
src/slices/notifications/module.ts    NotificationsSlice — provides the piece, exports only it
src/slices/audit/handler.ts           the auditor: orderAudit, one piece on the "orderAudit" consumer, built by AmqpHandler from Logger
src/slices/audit/module.ts            AuditSlice — same shape as NotificationsSlice
src/outbox-relay.ts    the publishing half: sweep the outbox, publish, mark sent — a resourceful provider
src/module.ts          orderHandlers = AmqpHandlers(orderContract)([orderNotifications, orderAudit]); OrderAmqpWorker — the composition root, an AmqpModule importing both slices and observability(), a constant
src/main.ts            the process: runMain(OrderAmqpWorker), and nothing else
src/test-fixtures.ts   boot / serve / tapped, as Vitest fixtures, against a real RabbitMQ — boot and tapped from @btravstack/testing
```

## Two subscribers, not one

This deployment is a modulith of **two** slices, `NotificationsSlice` and
`AuditSlice`, each draining its own queue off the one `orders` exchange
(`order-notifications`, `order-audit` — its own retry budget, its own
dead-letter parking). `defineContract` accepts two consumers of one
publisher because that is what a broadcast IS: neither subscriber knows the
other exists, and one slow reader cannot stall the other. `orderHandlers =
AmqpHandlers(orderContract)([orderNotifications, orderAudit])` composes the
two pieces into the one handlers record the starter needs — keyed by the
contract's own consumer names, so a consumer with no piece is a compile
error and two pieces claiming one consumer are di's duplicate-provider
defect at build.

**Neither slice owns a vertical.** Unlike `order-api`'s `OrdersSlice` /
`CustomersSlice`, which each import their own application-plus-persistence
pair, `NotificationsSlice` and `AuditSlice` import nothing: no domain, no
repository. That is the honest shape for this transport, not a weaker
version of the HTTP one — a subscriber reacts to a fact somebody else already
committed, so it has no business the way a controller handling a command
does. What each slice still declares for itself is the **ports its own
handler calls** — `Logger`, here, for both, but nothing stops one subscriber
from needing a service the other has no reason to know about. The vertical
in this deployment — `OrderApplicationModule` / `OrderPersistenceModule` —
belongs to the **relay**, the publishing half, not to either subscriber; it
sits in the root's own `imports` for that reason, next to the two slices
rather than inside one of them.

A wiring rule worth stating because it fails at runtime, not at compile
time: `orderHandlers`'s pieces are the composed provider's `deps`, and di's
`flatten` discovers providers only from a module's `imports` and `provides`
— never from a provider's own `deps`. So the root **must** import both
`NotificationsSlice` and `AuditSlice`, even though nothing in the root ever
names `orderNotifications` or `orderAudit` directly; dropping either import
leaves that piece's port unmet, and `start` fails with a `WiringDefect`
naming it — not a compile error.

## The pattern, in three places

**The write** is `OrderRepository.save` in `order-infrastructure`: the order
row and its `OutboxMessage` row commit in one `$tryTransaction`. There is no
"publish after save" call to forget, and no window where the order exists but
the fact of it is lost — the failure mode the naive `save(); publish();`
sequence carries by construction.

**The relay** is `src/outbox-relay.ts`: an infinite sweep — pull pending rows
in commit order, `publish("orderChanged", …)` each to the `orders` exchange,
mark what the broker confirmed. It is deliberately **at-least-once**: a crash
between publish and mark re-publishes on the next sweep, a broker outage
leaves rows pending and the sweep after the outage drains them. What is never
possible is the inverse — a committed order whose event evaporated.

**The two subscribers** are one plain function each, on the contract's
`order-notifications` and `order-audit` queues, each reacting to the same
fact its own way. Neither is the interesting part: a broadcast's publisher
does not know either exists, and the spec proves that by binding a _third_,
_foreign_ queue to the same exchange and receiving the same event too.

## Everything is a provider

`@btravstack/amqp`'s starter needs one thing from the application: its
**handlers, as a service**. This deployment builds that record from two
pieces rather than one function. `src/slices/notifications/handler.ts` is one
call — `AmqpHandler(orderContract, "orderNotifications")([Logger], { sync:
… })` — di's own `Provider(port)` on a port minted from the contract key,
typed for that one consumer's message; `src/slices/audit/handler.ts` is the
same shape for `"orderAudit"`. Neither declares a port class or a name: the
contract key IS the port's name, and each piece closes over only what its own
handler calls — both take `Logger` here, but nothing ties one subscriber's
dependencies to the other's. `src/module.ts` composes them —
`orderHandlers = AmqpHandlers(orderContract)([orderNotifications,
orderAudit])` — into the one handlers record `AmqpModule` takes: keyed by the
contract's consumer names, so a consumer with no piece is a compile error and
two pieces claiming one key are di's duplicate-provider defect at build. The
composition root is `AmqpModule("OrderAmqpWorker")({ contract: orderContract,
handlers: orderHandlers, imports, provides, exports })` — a `Module(...)` that
also takes the handlers provider: under the hood it imports the starter
(`amqp({ contract: orderContract })`, the runtime on
`AmqpRuntime` and the broker on `AmqpConfig`), provides `orderHandlers`, and
exports `AmqpRuntime` for `start` to resolve. Its `imports` also names
`NotificationsSlice` and `AuditSlice` themselves — not just their handlers —
because that is the only way di's `flatten` discovers the two pieces at all
(see "Two subscribers, not one" above). It also imports
`observability()`, the starter that provides the `Logger` every subscriber
writes to — `LOG_LEVEL` from the environment, JSON on stdout, and every
consumer line carrying its own delivery's unit. There is no `needs`, no
`context.ctx.get(...)`, and no port declared here over `RuntimePort` — the
package ships it.

The **relay** is a provider too, a resourceful one: `OutboxRelay` is acquired
as the graph builds — from `Outbox`, `Logger`, the `AmqpConfig` the starter
bound and its own `relayConfig.port` (`RelayConfig`, `OUTBOX_POLL_MS`, minted
by `Config.provider("RelayConfig")(schema)` since the slice is this
deployment's own) — and released when the application scope closes. Nothing resolves it, and nothing needs to; di
constructs every provider in the tree, and a resourceful one exists to be
started and stopped. It creates its own `TypedAmqpClient` rather than
receiving one as a port, because a transport connection is the transport's
own — and it is not a second connection either: `@amqp-contract/core` pools by
URL and reference-counts leases, so the relay's client and the consumer's
worker share one TCP connection, and `close()` releases a lease rather than
the socket.

That ordering is worth stating. The relay now starts **before** the consumer —
as the graph builds, where a broker it cannot reach fails startup, as it
always did — and stops **after** it, when the scope closes rather than inside
the runtime's `stop`. That is fine: the relay's client holds its own lease, so
the consumer's close does not pull the connection from under it, and pending
rows published during the drain window are safer out than abandoned to the
next boot. `drain` stays the consumer's alone — draining means "stop taking new
work", and the relay's work is outbound.

Configuration is read inside the graph, so the composition root is a
**constant**: `main.ts` is `await runMain(OrderAmqpWorker)`, and the specs boot
the same value with `env: { AMQP_URL: <this test's vhost>, DATABASE_URL,
OUTBOX_POLL_MS: "25", OUTBOX_TENANTS: <this test's tenant> }`.
The compile-time half (`src/needs-gate.test-d.ts`) pins that `start` finds the
runtime, and that a composition which forgets to provide `orderHandlers` is
refused — by di's needs channel now, since the runtime itself has no needs
left for `start`'s gate to check (spelled with the `amqp()` primitive, since
the sugar cannot leave the handlers out).

## The environment

| Variable         | Default                 | What it is                                    |
| ---------------- | ----------------------- | --------------------------------------------- |
| `AMQP_URL`       | `amqp://127.0.0.1:5672` | the broker (`AmqpConfig`), consumer and relay |
| `PROBE_PORT`     | `9000`                  | `/livez` / `/readyz`                          |
| `OUTBOX_POLL_MS` | `200`                   | the relay's idle sleep (`RelayConfig`)        |
| `OUTBOX_TENANTS` | _(required)_            | the tenants the relay sweeps, comma-separated |
| `DATABASE_URL`   | _(required)_            | the orders database (`DatabaseConfig`)        |
| `LOG_LEVEL`      | `info`                  | the `Logger`'s floor (`LoggerConfig`)         |

`OUTBOX_POLL_MS=0` is rejected at boot — a relay that never sleeps is a busy
loop — and so is anything above `60000`. A bad value, or an empty one, is a
`ConfigInvalid` the kernel reports itself: a `startFailed` event naming the
variable, and exit code 78 (`EX_CONFIG`) under `runMain`. `PROBE_PORT` is the
kernel's own, read the same way.

## Running the specs

The suite runs against a **real RabbitMQ** in a testcontainer (Docker
required): a write placed through the application's own `PlaceOrder` crosses
the outbox, the broker and the queue, and comes back as the notifier's own
notification — commit order preserved, outbox drained, a cancellation
arriving as a tombstone behind its placement, one event landing on both
subscribers' queues, and the same event delivered to a subscriber this
contract never heard of, on a third, foreign queue.

```bash
pnpm --filter @btravstack/example-order-amqp-worker test        # broadcast e2e
pnpm --filter @btravstack/example-order-amqp-worker typecheck   # the needs gate
```

The suite needs a **Docker daemon**: a RabbitMQ and a PostgreSQL, both shared
by the whole repository ([`internal/test-infra`](../../internal/test-infra/README.md)).
Nothing is started per workspace and nothing is cleaned up between tests — each
test gets a **vhost** of its own from `@amqp-contract/testing`'s `it` extension
and a **tenant** of its own on the one migrated database.

Tenancy crosses the broker here, which the other two deployments do not have to
do: a broadcast leaves the process. The **contract** carries it — `tenantId` is
a field on the envelope — so the relay reads it off the outbox row, puts it on
the event, and a subscriber reads it off the message it was already handed.
`@btravstack/amqp` knows nothing about tenants; there is nothing to configure
and nothing to hook.

The relay is told which tenants it serves, `OUTBOX_TENANTS`, and that is the
case that shows why ambient context would not have been enough anyway: a
background sweep has no delivery behind it, so there is nothing to read a
tenant from — and "whatever is in the table" is how one deployment starts
broadcasting another's facts.

The fixtures are [`@btravstack/testing`](../../packages/testing)'s: `serve`
boots the worker against the test's own vhost through the `boot` fixture, so
it is stopped when the test ends, and `tapped` hands back the very
`PlaceOrder`, `OrderRepository` and `Outbox` the running app was
built with — the writer the spec places orders through is the one the relay
sweeps. Neither subscriber's own lines need a tap: the fixture composes the
root's shape with `observability({ sink })`, so what each one said arrives as
`Line` values and the assertions read `{ message, orderId, quantity }` rather
than a formatted sentence.

## What this deployment deliberately is not

It is not a command queue. Nothing here asks a worker to _do_ anything — the
event is past tense, the publisher does not address a consumer, and removing
the notifier would inconvenience nobody but the notifier's users. When the
journey needs an owner — steps in order, compensation on failure — that is
orchestration, and it lives in [`order-temporal-worker`](../order-temporal-worker).
