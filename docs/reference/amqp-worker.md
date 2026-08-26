---
title: "@btravstack/amqp-worker"
description: The AMQP starter — AmqpModule, AmqpHandlers, amqp(), AmqpRuntime, AmqpConfig and AmqpInfo, the unit per delivery, the drain with one deadline, and the three-way ack/nack/dead-letter split it declines to own.
---

<!-- doctest: prelude
import { Logger, Tracer } from "@btravstack/core";
import { AmqpHandler, AmqpHandlers, AmqpModule } from "@btravstack/amqp-worker";
import { Env } from "@btravstack/config";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OkAsync } from "unthrown";
import { OrderApplicationModule, OrderRepository, Outbox, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { outboxRelay, relayConfig } from "../../outbox-relay.js";
import { AuditSlice } from "../../slices/audit/module.js";
import { NotificationsSlice } from "../../slices/notifications/module.js";
-->

# @btravstack/amqp-worker

> **Reference.** A complete, structured description of the AMQP starter's
> public surface: every export of `@btravstack/amqp-worker`, its options and
> defaults, what a delivery becomes, and how its drain meets the kernel's
> deadline. For the task, see
> [Consume AMQP messages](/how-to/consume-amqp-messages); for the reasoning,
> [Starters](/explanation/starters) and
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing); for the
> worked example, [Order AMQP worker](/examples/order-amqp-worker). Generated
> signatures are under [API reference](/api/amqp-worker/).

## Exports

`packages/amqp-worker/src/index.ts` exports exactly this:

| Export                  | Kind  | What it is                                                                                                                                                                                                                 |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AmqpModule`            | value | `AmqpModule(name)({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?, connectTimeoutMs?, imports?, provides?, exports?, needs? })` — a di `Module(name)({...})` that also takes the handlers provider |
| `AmqpModuleOptions`     | type  | The options object `AmqpModule(name)` takes                                                                                                                                                                                |
| `AmqpHandlers`          | value | `AmqpHandlers(contract)` — di's `Provider(port)` builder on the starter's own handlers port, typed for `contract`, so the next call is `({ name: Dep }, arm)`, or `([pieces])` to compose one provider per consumer/rpc    |
| `HandlersPortOf<C>`     | type  | The handlers port's class typed for `C` — what a composed `orderHandlers`'s `.port` is                                                                                                                                     |
| `HandlersInstanceOf<C>` | type  | That port's instance typed for `C` (service `WorkerInferHandlers<C>`)                                                                                                                                                      |
| `AmqpHandler`           | value | `AmqpHandler(contract, key)` — one consumer or rpc as a provider of its own, typed by `key` alone; the next call is `({ name: Dep }, arm)`, and the piece is what `AmqpHandlers(contract)([...])` composes                 |
| `HandlerPortOf<C, K>`   | type  | One piece's port class, typed for the one key `K` it implements                                                                                                                                                            |
| `amqp`                  | value | `amqp({ contract, … })` — the starter module itself, needing the handlers port for `contract`; what `AmqpModule` imports                                                                                                   |
| `AmqpOptions`           | type  | `amqp()`'s options                                                                                                                                                                                                         |
| `AmqpRuntime`           | value | `class AmqpRuntime extends RuntimePort<Runtime<never, AmqpInfo>> {}` — the runtime's port                                                                                                                                  |
| `AmqpConfig`            | value | `class AmqpConfig extends Port("AmqpConfig")<{ url: string }> {}` — the broker, bound from `AMQP_URL`; a publisher sharing the consumer's broker reads it too                                                              |
| `AmqpInfo`              | type  | `{ readonly queues: readonly string[] }` — published on `Serving.info` once consuming                                                                                                                                      |

`HandlersPortOf<C>` / `HandlersInstanceOf<C>` / `HandlerPortOf<C, K>` are
exported as **types only**, and only because declaration emit forces it: an
application that composes `orderHandlers = AmqpHandlers(contract)([piece,
piece])` and exports it by name (or a slice that exports one piece by name)
needs to be able to print that type, and a type built from an unexported
alias fails TS4023 ("has or is using name 'ID' … but cannot be named") the
moment it tries. `AnyAmqpContract` —
`Parameters<typeof TypedAmqpWorker.create>[0]["contract"]`, the bound on
`contract` — lives in `src/amqp-runtime.ts` and is **not** exported from the
entry point; it is extracted from the worker's own signature so
`@amqp-contract/contract` stays out of the peer range. The **values** behind
the two handlers ports stay unexported on the same terms as
`AnyAmqpContract`: `AmqpHandlersPort` — `Port("AmqpHandlers")`, the starter's
own handlers port, declared once — and `HANDLER_PREFIX` (`handler.ts`), the
string prefix a piece's port id carries. Nothing outside this package
legitimately constructs a provider against either bare port — a consumer
always goes through `AmqpHandlers(contract)` or `AmqpHandler(contract, key)`,
both of which cast it to the typed alias — so there is nothing a value export
would help with. `HandlerKeyOf<C>` (`handler.ts`) is unexported for the same
reason: nothing outside that file needs to name a bare key. The port is
reached as `provider.port` when a caller needs it.

## `AmqpModule(name)({...})`

Everything `Module(name)({...})` takes, plus the contract, the handlers
provider and the starter's own options. It appends
`amqp({ contract, … })` to `imports`, prepends
`handlers` to `provides`, prepends `AmqpRuntime` to `exports`, and hands the
augmented tuples to di's own `Module(name)`.

| Option                   | Required | Default              | What it is                                                                                                                                                                                                                                        |
| ------------------------ | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`               | yes      | —                    | an `amqp-contract` contract; the queues consumed are read off its `consumers` and `rpcs`                                                                                                                                                          |
| `handlers`               | yes      | —                    | the handlers **provider** — a `Provider<HandlersInstanceOf<TContract>, E, N>`, what `AmqpHandlers(contract)(deps, arm)` returns for **this** `contract`, one entry per `consumers` / `rpcs` key; one built for another contract fails at the call |
| `url`                    | no       | read from `AMQP_URL` | pins the broker — a test's container                                                                                                                                                                                                              |
| `connectionOptions`      | no       | —                    | `AmqpConnectionOptions`, the connection tuning `TypedAmqpWorker.create` accepts: heartbeat, reconnect interval, `findServers`, TLS/socket options                                                                                                 |
| `defaultConsumerOptions` | no       | —                    | `@amqp-contract/worker`'s `ConsumerOptions`, applied to every handler: `prefetch` (the throughput knob), `priority`, `arguments`, `consumerTag`, `exclusive`                                                                                      |
| `connectTimeoutMs`       | no       | the library's 30 s   | how long `create` waits for the connection; a **top-level** `CreateWorkerOptions` field, not one under `connectionOptions`, where setting it is silently inert                                                                                    |
| `imports`                | no       | `[]`                 | the application's modules                                                                                                                                                                                                                         |
| `provides`               | no       | `[]`                 | the application's own providers                                                                                                                                                                                                                   |
| `exports`                | no       | `[]`                 | the application's own exports; `AmqpRuntime` is added                                                                                                                                                                                             |

The worked composition root, from `examples/order-amqp-worker/src/module.ts`:

<!-- doctest: group=order-amqp-worker -->
<!-- doctest: defer -->

```ts
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    observability(),
    otel(),
  ],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger, Tracer],
});
```

`NotificationsSlice` and `AuditSlice` are each a slice module exporting one
**piece** of `orderHandlers` — see the composing form below and
[Split a worker into slices](/how-to/split-a-worker-into-slices) — imported
here because `orderHandlers`'s own `deps` are the pieces' ports, and di
discovers a provider only through a module's `imports` / `provides`, never
through another provider's `deps`.

[`observability()`](/reference/observability) is a second starter, not this
package's business: it brings the `Logger` the handlers and the relay write
to, bound from `LOG_LEVEL`, JSON per line on stdout, every line carrying the
delivery's own unit.

## `AmqpHandlers(contract)`

The first call fixes the contract type (the value is otherwise unused) and
returns `ReturnType<typeof Provider<HandlersPortOf<C>>>` — di's own
`Provider(port)` builder on the starter's handlers port, typed for `C` — so
the second call is di's `(deps, arm)` unchanged, checked against the
contract's record before any module sees it (a record missing a consumer, or
with a typo'd key, is refused here), and the provider carries the port as
`provider.port`. There is no name to give: a consumer serves one handlers
record as it boots one runtime, so the port is the starter's — one
`Port("AmqpHandlers")`, generic at the value level and fixed per contract at
the type level (`HandlersPortOf<C>`, the move the kernel's `RuntimePort`
makes) — and two handlers providers in one graph are di's duplicate-provider
defect at build. Each handler is a bare
function of the message its consumer declares; `WorkerInferHandlers<C>`
accepts it with nothing wrapped around it, and no context is injected. A
record covers **every** consumer and rpc the contract declares —
`orderContract` has two, `orderNotifications` and `orderAudit`, both reading
the one `orderChanged` event on their own queue:

```ts
export const orderHandlers = AmqpHandlers(orderContract)(
  { logger: Logger },
  {
    sync: ({ logger }) => ({
      orderNotifications: (message) => {
        const { tenantId, id, payload } = message.payload;
        logger.info(
          payload === null
            ? "order gone — notifying"
            : "order placed — notifying",
          {
            tenantId,
            orderId: id,
            ...(payload === null ? {} : { quantity: payload.quantity }),
          },
        );
        return OkAsync();
      },
      orderAudit: (message) => {
        const { tenantId, id, occurredAt, payload } = message.payload;
        logger.info("recording an order change", {
          tenantId,
          orderId: id,
          occurredAt,
          change: payload === null ? "removed" : "placed",
        });
        return OkAsync();
      },
    }),
  },
);
```

`examples/order-amqp-worker` no longer calls `AmqpHandlers` this way — its two
consumers are each a slice's own piece instead (below) — but the monolithic
form is unchanged, and still what
[Consume AMQP messages](/how-to/consume-amqp-messages) teaches for a worker
that has not outgrown one function.

A third call composes several **pieces** instead of one record:
`AmqpHandlers(contract)([piece, piece, ...])`, where each piece is what
`AmqpHandler(contract, key)({ name: Dep }, arm)` returns. Di constructs every
piece first — they are the composed provider's own `deps`, declared under the
very key each piece's port id carries, so the services record IS the handlers
record. Every key the contract declares must be covered: an array
missing one is refused at the call, against an
`"UNCOVERED HANDLERS — the contract declares a consumer this array does not cover"`
marker. The diagnostic is a three-line `TS2769` and the sentence is at the
**tail of the third line**, past three hundred characters of the caller's own
contract type — measured, and not shortenable from inside this package. The
missing key itself is named too once the array's length matches that marker
tuple's own length of 2: TypeScript then matches the array against the tuple
positionally and reports the trailing element separately — measured against
this example's two-consumer contract, `is not assignable to type
'"orderAudit"'`: the bare key, not the marker tuple. A single-element array's
diagnostic names the marker alone; a piece built for another contract
is refused too, structurally, since its port's service is that contract's
handler for the key. `Uncovered` checks coverage, not injectivity, so two
pieces claiming the same key still type-check together; di's duplicate-provider
defect at build catches it only once **both** end up discharged as providers
in the same graph — wire in just one and the other is silently unregistered,
with no diagnostic. The composed provider's own `deps` are
the **pieces' ports**, not what a piece closes over, so the pieces themselves
still need discharging like any other need — typically `provides: [...]` on
the module, or a slice module that exports its own piece.

## `AmqpHandler(contract, key)`

One consumer or rpc, as a provider of its own: the port id carries the
contract key (`` `AmqpHandler:${key}` ``, `HANDLER_PREFIX` stripped by the
composing form to recover it), so two slices claiming one consumer is di's
duplicate-provider defect rather than a silent merge. `contract` types `key`
and the handler; a key the contract does not declare is refused at the call —
there is nothing to type it by — and a handler whose message has drifted is a
compile error here rather than at the root. There is no name to give and
nothing minted by hand: the return is di's own `Provider(port)`, so every arm
— `value` / `sync` / `make` / `class` / `acquire` — is available exactly as it
is on `AmqpHandlers(contract)`, and the provider carries its port as
`provider.port` (`HandlerPortOf<C, K>`).

<!-- doctest: isolate
import { AmqpHandler, AmqpHandlers } from "@btravstack/amqp-worker";
import { Logger } from "@btravstack/core";
import { OkAsync } from "unthrown";
import { orderContract } from "@btravstack/example-order-amqp-contract";
-->

```ts
const orderNotifications = AmqpHandler(orderContract, "orderNotifications")(
  { logger: Logger },
  {
    sync:
      ({ logger }) =>
      (message) => {
        logger.info("order changed", { orderId: message.payload.id });
        return OkAsync(undefined);
      },
  },
);

const orderAudit = AmqpHandler(orderContract, "orderAudit")(
  { logger: Logger },
  {
    sync:
      ({ logger }) =>
      (message) => {
        logger.info("order audited", { orderId: message.payload.id });
        return OkAsync(undefined);
      },
  },
);

const orderHandlers = AmqpHandlers(orderContract)([
  orderNotifications,
  orderAudit,
]);
```

## `amqp(options)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
const amqp: <TContract extends AnyAmqpContract>(
  options: AmqpOptions<TContract>,
) => Module<
  AmqpRuntime | AmqpConfig,
  ConfigInvalid,
  Env | HandlersInstanceOf<TContract>
>;
```

The primitive `AmqpModule` delegates to. `AmqpOptions<TContract>` has the
sugar's fields minus `handlers` / `imports` / `provides` / `exports`: the
handlers are not an option but the module's need. It provides and exports
`AmqpRuntime` and `AmqpConfig`, and **needs** `Env` (the kernel discharges
it) and the handlers port typed for `contract` (`HandlersInstanceOf<TContract>`)
— the runtime provider depends on it through di, so a root that imports the
starter without providing the handlers, or provides one built for another
contract, is refused at `start` (di's gate). The declared type is the same with `url` pinned or not.

## `AmqpConfig`, and the environment

Bound through [`Config.provider`](/reference/config) unless `url` is pinned.

| Variable   | Default                 | Parsed by       |
| ---------- | ----------------------- | --------------- |
| `AMQP_URL` | `amqp://127.0.0.1:5672` | `Config.string` |

A blank value is a `ConfigInvalid` — `startFailed` and exit `78` under
`runMain`.

## `AmqpRuntime` and `AmqpInfo`

Declared over the kernel's `RuntimePort` with service
`Runtime<never, AmqpInfo>` — it resolves nothing. Its `start` calls
`TypedAmqpWorker.create({ contract, handlers, middleware, urls: [url], … })`.
`create` reports a connection failure on the **defect** channel with a
`TechnicalError` cause; the starter recovers that into
`Err(RuntimeStartFailed({ runtime: "amqp", cause }))`, which is what keeps an
unreachable broker at exit `1` rather than `70`.

`AmqpInfo.queues` is **derived** — every queue named by the contract's
`consumers` and `rpcs`, sorted and de-duplicated — never configured, so
`Serving.info` cannot disagree with what the worker consumes.

## The unit

One unit per **delivery**, `kind: "delivery"`, opened by the starter's own
`WorkerMiddleware`, which calls `next()` unchanged — it injects nothing, and
the handler's own `Result` is what the worker routes. The ambient
`currentUnit()` record is therefore the only route to the unit's
`AbortSignal` from inside a handler: `currentUnit()?.signal`, aborted at the
kernel's `drainTimeoutMs`. This transport has no cancellation of its own to
defer to — an un-acked delivery is redelivered, which is recovery, not
cancellation — so answering a `RetryableError` on an aborted signal is what
hands the message to the next worker.

| `UnitMeta` field | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`             | `randomUUID()`, minted per delivery                                                                              |
| `traceId`        | the publisher's `messageId`, else `correlationId` (an RPC-shaped message), else the minted `id` — non-blank only |

A **delivery tag is not a unit id**: tags are per-channel and restart at `1`
after a reconnect, which `amqp-connection-manager` performs silently
underneath the worker — the one identifier that looks unique per delivery is
not, across exactly the event this library exists to handle.
`consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
caller pin `consumerTag`. Minting is the only form of the rule that survives.
A blank `messageId` is ignored rather than adopted, since `""` is not nullish
and would otherwise give every delivery the same trace id.

## The drain, and the one deadline

`Serving.drain(signal)` calls `worker.close({ drainTimeoutMs: null })` —
cancel every consumer, let in-flight handlers finish so their acks land on a
still-open channel, then close — **raced against `signal`**, the kernel's
deadline. `stop()` reuses whatever deadline `drain` armed, so a signal-driven
shutdown never waits twice; called alone, it waits on the worker's own close.

`drainTimeoutMs: null` is deliberate: the library's own default drain timeout
is 30 s, above the kernel's 20 s default, and would quietly win. Passing
`null` removes the second clock instead of requiring it be kept under the
first — one deadline in the process, the kernel's.

When the deadline wins, `close()` keeps running underneath: the connection
stays open and the in-flight handler keeps heading toward its own ack or nack
on the library's clock. The kernel reports the unit `abandoned`, which is
honest about what _it_ waited for. Redelivery happens only once the connection
actually drops — when the **process** dies, not when the kernel's deadline
passes.

## Peer dependencies

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`,
`@amqp-contract/worker`, `@opentelemetry/api`. `@opentelemetry/api` is a peer
because `@amqp-contract/worker` itself peers on it; `@amqp-contract/contract`
is **not** in the list — it is a devDependency of the package, used only to
type its own tests. Node `>=22`.

## Deliberately not included

- **`Result` → ack / retry / dead-letter.** On this transport that is a
  **three-way** split, and the package owns none of it. `amqp-contract`'s own
  dispatch routes a modeled `RetryableError` / `NonRetryableError` against
  the queue's `retry` config. A `Defect` is **not** routed that way: it is
  nacked once, immediately, under its original routing key, never touching
  the retry budget — so a handler that wants "infrastructure comes back" must
  recover its own `Defect`s into a `RetryableError` explicitly, or an
  infrastructure failure is parked on the first attempt exactly like a
  permanent domain error. Note also that
  `retry: { mode: "ttl-backoff", maxRetries: 3 }` means **four** total
  attempts, not the three Temporal's `maximumAttempts: 3` names.
- **A publisher.** The starter runs a consumer; publishing is
  `@amqp-contract/client`'s job (the worked example's outbox relay creates
  its own client from the same `AmqpConfig`).
- **A context channel.** A handler reads nothing out of a context; what it
  needs, its provider declares.

## Testing

The package's own suite needs a Docker daemon: `@amqp-contract/testing`
boots one RabbitMQ container per vitest run, because the retry and
dead-letter routing it relies on is the broker's behaviour, not something an
in-memory fake could stand in for. `amqp-runtime.spec.ts` carries 8 specs;
`handler.spec.ts` adds 2 more — a broadcast with two consumers of one
publisher, composed from two pieces, pinning that both run and that each was
built from the ports its own provider declared rather than a record closing
over both — for 10 total. `handler.test-d.ts` pins the composing form's
compile-time gates: a piece typed by its own key, an array covering every
declared key, a missing key refused and named, and a piece built for another
contract refused structurally.
