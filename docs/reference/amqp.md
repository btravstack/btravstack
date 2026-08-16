---
title: "@btravstack/amqp"
description: The AMQP starter — AmqpModule, AmqpHandlers, amqp(), AmqpRuntime, AmqpConfig and AmqpInfo, the unit per delivery, the drain with one deadline, and the three-way ack/nack/dead-letter split it declines to own.
---

# @btravstack/amqp

> **Reference.** A complete, structured description of the AMQP starter's
> public surface: every export of `@btravstack/amqp`, its options and
> defaults, what a delivery becomes, and how its drain meets the kernel's
> deadline. For the task, see
> [Consume AMQP messages](/how-to/consume-amqp-messages); for the reasoning,
> [Starters](/explanation/starters) and
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing); for the
> worked example, [Order AMQP worker](/examples/order-amqp-worker). Generated
> signatures are under [API reference](/api/amqp/).

## Exports

`packages/amqp/src/index.ts` exports exactly this:

| Export              | Kind  | What it is                                                                                                                                                                                                         |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AmqpModule`        | value | `AmqpModule(name)({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?, connectTimeoutMs?, imports?, provides?, exports? })` — a di `Module(name)({...})` that also takes the handlers provider |
| `AmqpModuleOptions` | type  | The options object `AmqpModule(name)` takes                                                                                                                                                                        |
| `AmqpHandlers`      | value | `AmqpHandlers(contract)(name)` — mints the handlers port and returns di's `Provider(port)` builder, so the next call is `(deps, arm)`                                                                              |
| `amqp`              | value | `amqp({ contract, handlers, … })` — the starter module itself, over a handlers **port class**; what `AmqpModule` imports                                                                                           |
| `AmqpOptions`       | type  | `amqp()`'s options                                                                                                                                                                                                 |
| `AmqpRuntime`       | value | `class AmqpRuntime extends RuntimePort<Runtime<never, AmqpInfo>> {}` — the runtime's port                                                                                                                          |
| `AmqpConfig`        | value | `class AmqpConfig extends Port("AmqpConfig")<{ url: string }> {}` — the broker, bound from `AMQP_URL`; a publisher sharing the consumer's broker reads it too                                                      |
| `AmqpInfo`          | type  | `{ readonly queues: readonly string[] }` — published on `Serving.info` once consuming                                                                                                                              |

`AnyAmqpContract` — `Parameters<typeof TypedAmqpWorker.create>[0]["contract"]`,
the bound on `contract` — lives in `src/amqp-runtime.ts` and is **not**
exported from the entry point; it is extracted from the worker's own signature
so `@amqp-contract/contract` stays out of the peer range.

## `AmqpModule(name)({...})`

Everything `Module(name)({...})` takes, plus the contract, the handlers
provider and the starter's own options. It appends
`amqp({ contract, handlers: handlers.port, … })` to `imports`, prepends
`handlers` to `provides`, prepends `AmqpRuntime` to `exports`, and hands the
augmented tuples to di's own `Module(name)`.

| Option                   | Required | Default              | What it is                                                                                                                                                                                         |
| ------------------------ | -------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`               | yes      | —                    | an `amqp-contract` contract; the queues consumed are read off its `consumers` and `rpcs`                                                                                                           |
| `handlers`               | yes      | —                    | the handlers **provider** — a `Provider<HandlersInstance, E, N>` whose port's service is `WorkerInferHandlers<TContract>`, one entry per `consumers` / `rpcs` key; anything else fails at the call |
| `url`                    | no       | read from `AMQP_URL` | pins the broker — a test's container                                                                                                                                                               |
| `connectionOptions`      | no       | —                    | passed through to `TypedAmqpWorker.create`                                                                                                                                                         |
| `defaultConsumerOptions` | no       | —                    | passed through to `TypedAmqpWorker.create`                                                                                                                                                         |
| `connectTimeoutMs`       | no       | the library's 30 s   | how long `create` waits for the connection; a **top-level** `CreateWorkerOptions` field, not one under `connectionOptions`, where setting it is silently inert                                     |
| `imports`                | no       | `[]`                 | the application's modules                                                                                                                                                                          |
| `provides`               | no       | `[]`                 | the application's own providers                                                                                                                                                                    |
| `exports`                | no       | `[]`                 | the application's own exports; `AmqpRuntime` is added                                                                                                                                              |

The worked composition root, from `examples/order-amqp-worker/src/module.ts`:

```ts
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [ApplicationModule, PersistenceModule],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
```

## `AmqpHandlers(contract)(name)`

The first call fixes the contract type (the value is otherwise unused). The
second mints `class extends Port(name)<WorkerInferHandlers<C>> {}` and
returns `ReturnType<typeof Provider<PortClassOf<Name, WorkerInferHandlers<C>>>>`
— di's own `Provider(port)` builder — so the third call is di's `(deps, arm)`
unchanged, checked against the contract's record before any module sees it,
and the provider carries the port as `provider.port`. Each handler is a bare
function of the message its consumer declares; `WorkerInferHandlers<C>`
accepts it with nothing wrapped around it, and no context is injected. From
`examples/order-amqp-worker/src/handlers.ts`:

```ts
export const orderHandlers = AmqpHandlers(orderContract)("OrderHandlers")(
  [Logger],
  {
    sync: (logger) => ({
      orderChanged: (message) => {
        const { id, payload } = message.payload;
        logger.info(
          payload === null
            ? `order ${id} is gone — notifying`
            : `order ${id} placed — notifying (${payload.quantity} items)`,
        );
        return OkAsync();
      },
    }),
  },
);
```

## `amqp(options)`

```ts
const amqp: <TContract extends AnyAmqpContract, H extends AnyPort>(
  options: AmqpOptions<TContract, H>,
) => Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env | InstanceType<H>>;
```

The primitive `AmqpModule` delegates to. `AmqpOptions<TContract, H>` has the
sugar's first six fields, with `handlers` the **port class** constrained
`H & HandlersPort<H, TContract>` — a port whose service misses a consumer or
names one the contract does not declare fails to typecheck here, not on the
first delivery. The module provides and exports `AmqpRuntime` and
`AmqpConfig`, and **needs** `Env` (the kernel discharges it) and the handlers
port's instance — the runtime provider depends on it through di, so a root
that imports the starter without providing the handlers is refused at
`start` (di's gate). The declared type is the same with `url` pinned or not.

## `AmqpConfig`, and the environment

Bound through [`Config.provider`](/reference/config) unless `url` is pinned.

| Variable   | Default                 | Parsed by       |
| ---------- | ----------------------- | --------------- |
| `AMQP_URL` | `amqp://127.0.0.1:5672` | `Config.string` |

A blank value is a `ConfigInvalid` — `startFailed` and exit `78` under
`runMain`.

## `AmqpRuntime` and `AmqpInfo`

Declared over the kernel's `RuntimePort` with service
`Runtime<never, AmqpInfo>` — no needs. Its `start` calls
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
the handler's own `Result` is what the worker routes.

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
type its own tests. Node `>=20`.

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
in-memory fake could stand in for.
