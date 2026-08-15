# @btravstack/amqp

**The AMQP starter for
[`@btravstack/core`](https://github.com/btravstack/start): one unit per
delivery, and a drain with exactly one deadline — the kernel's own.**

It runs an [`amqp-contract`](https://github.com/btravstack/amqp-contract)
`TypedAmqpWorker` under the kernel's lifecycle: bind the connection, open one
kernel unit per delivery, and — unlike `@btravstack/temporal`, which races the
kernel's deadline against a library that also keeps its own — tell the library
to wait forever and let the kernel's signal be the only clock in the process.
The handlers are the application's, as a port it provides; the runtime is a
module that depends on that port.

## Install

```sh
pnpm add @btravstack/amqp @btravstack/core @btravstack/config @btravstack/di \
  unthrown @amqp-contract/worker @opentelemetry/api
```

All six are peer dependencies — install them. `@opentelemetry/api` is one
because `@amqp-contract/worker` itself peers on it; `@amqp-contract/contract`
is **not** in this list — it is a devDependency of this package, used only to
type its own tests, and never appears in the published type surface. Node
`>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A worked example

The application provides its **handlers as a provider** — one that declares
the use cases the handlers call, so they are built by di like everything else
and no context is injected — and `AmqpModule(name)({...})` is a
`Module(name)({...})` that also knows about it: everything a di module takes,
plus `contract` and `handlers`, and nothing else to know. Under the hood it
imports the starter (`amqp({ contract, handlers })` — the runtime on
`AmqpRuntime`, the broker on `AmqpConfig` from `AMQP_URL`), provides the
handlers and exports `AmqpRuntime`, and hands back exactly the module
`Module(...)` would have declared: syntax over the same primitives.

```ts
import { runMain } from "@btravstack/core";
import { AmqpHandlers, AmqpModule } from "@btravstack/amqp";

// The handlers, as a service: `AmqpHandlers(contract)(name)` mints a port
// whose service is the record the contract wants —
// `WorkerInferHandlers<typeof orderContract>`, one entry per consumer / RPC,
// no injected context — and hands back di's own `Provider(port)`, so the
// last call declares what the handlers need and closes over it, the way
// every service in the graph is built. `orderHandlers.port` is the port,
// for whoever needs to name it.
const orderHandlers = AmqpHandlers(orderContract)("OrderHandlers")(
  [PlaceOrder],
  {
    sync: (placeOrder) => ({
      placeOrder: declareHandler(orderContract, "placeOrder", (message) =>
        placeOrder
          .execute(message.payload.orderId, message.payload.quantity)
          .map(() => undefined)
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("InvalidQuantity"),
              P.tag("DuplicateOrder"),
              (error) => new NonRetryableError(error._tag, error),
            ),
          )
          .recoverDefect((cause) =>
            ErrAsync(new RetryableError("placing the order failed", cause)),
          ),
      ),
    }),
  },
);

const Worker = AmqpModule("Worker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [AppModule],
});

await runMain(Worker);
```

`AmqpModule(name)({ contract, handlers, url?, connectionOptions?,
defaultConsumerOptions?, connectTimeoutMs?, imports?, provides?, exports? })`
takes everything `Module(name)({...})` takes, plus the contract, the handlers
**provider** and the starter's own options; `AmqpRuntime` is added to the
exports since `start` resolves it. `handlers` is checked against `contract` at
the call site, on the provider's port — a provider whose service misses a
consumer or names one the contract does not declare fails to typecheck there,
rather than on the first delivery, silently to the DLQ
(`amqp-runtime.test-d.ts` pins both directions, for the sugar and the
primitive alike).

`AmqpHandlers(contract)(name)` is the way to that provider: the first two
calls mint the port — id `name`, service `WorkerInferHandlers<typeof
contract>` — and return di's own `Provider(port)`, so the last call is exactly
`Provider(port)(deps, arm)`: any arm, same typing, and the arm is checked
against the contract's record before any module sees it. The provider carries
the port typed (`orderHandlers.port`, a `HandlersPortClass<Name, typeof
contract>`) for the rare place that names it — a hand-written `amqp()` call, a
type test. A port declared by hand (`class OrderHandlers extends
Port("OrderHandlers")<WorkerInferHandlers<typeof orderContract>> {}` plus
`Provider(OrderHandlers)(…)`) still works everywhere the minted one does; the
class line is what the sugar removes.

`amqp({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?,
connectTimeoutMs? })` — the starter module itself, taking the handlers **port
class** rather than the provider — stays exported for a composition root
written by hand: `Module("Worker")({ imports: [AppModule, amqp({ contract:
orderContract, handlers: orderHandlers.port })], provides: [orderHandlers],
exports: [AmqpRuntime] })` is what the sugar produces. It returns a `Module<AmqpRuntime
| AmqpConfig, ConfigInvalid, Env | H>` — `H` the handlers port's instance, the
module's one need — or, with `url` pinned, `Module<AmqpRuntime | AmqpConfig,
never, H>`: it then reads nothing from the environment. (`AmqpModule` declares
the unpinned type either way; a pinned `url` still binds nothing.)

There is no context channel: a handler reads nothing out of a `context.ctx`,
because it was built from its dependencies by di. The middleware this package
installs opens the unit and calls `next()` unchanged, and the ambient
`currentUnit()` record — trace id included — is what the unit leaves for the
adapters that read it.

## What it owns, and what it declines

It owns the worker's connection, the unit boundary around every delivery, and
the release at the kernel's deadline.

It does **not** map a `Result` to ack / retry / dead-letter — and here the
honest answer is a **three-way split**, not the clean one-line handoff
`@btravstack/temporal` gets to make. `amqp-contract`'s own dispatch routes a
modeled `RetryableError` / `NonRetryableError` by the queue's `retry` config —
that much the library owns. A `Defect` is the third thing, and it is **not**
routed the same way: `dispatchMessage` nacks it once, immediately, under its
original routing key, never touching the queue's `retry` budget at all. So an
infrastructure failure that is not explicitly recovered is parked on its first
attempt exactly like a permanent domain error — `.recoverDefect((cause) =>
ErrAsync(new RetryableError(...)))` in the worked example above is not
decoration, it is what keeps "infrastructure comes back" true on this
transport. A queue's `retry: { mode: "ttl-backoff", maxRetries: 3 }` also means
**four** total attempts (the first, plus three retries) — do not read it as the
same number Temporal's `maximumAttempts: 3` names, which counts the first
attempt too.

## The drain, and the one deadline

`Serving.drain(signal)` calls `worker.close({ drainTimeoutMs: null })` —
cancel every consumer, let in-flight handlers finish so their acks land on a
still-open channel, then close — **raced against `signal`**, the kernel's own
deadline.

`drainTimeoutMs: null` is what makes this package simpler than
`@btravstack/temporal`: the library's own default drain timeout is 30 seconds,
which would sit above the kernel's 20-second default and quietly win, giving
the process two deadlines that could disagree. Telling the library to wait
forever removes the second one entirely — there is nothing here to keep in sync
with `StartOptions.drainTimeoutMs`, because there is nothing else counting.
`stop()` reuses whatever deadline `drain` armed, so a signal-driven shutdown
never waits twice; called on its own, with no drain having happened, there is
no deadline to race, and `stop()` waits on the worker's own close.

## What abandonment costs

When the kernel's deadline wins the race, the runtime returns and the worker's
`close()` call is still running underneath — polling has already stopped, but
nothing was dropped: the connection stays open and the in-flight delivery's
handler keeps running toward its own ack or nack in the background, on the
library's clock rather than the kernel's. The kernel is released on time and
reports the unit `abandoned`, which is honest about what _it_ waited for, not
about what became of the message.

Redelivery is a real property of the broker, but only once the connection
actually drops — which happens when the **process** exits, not when the
kernel's drain deadline does. A pod that survives past `drainTimeoutMs` and
into `stopping` before being SIGKILLed keeps the connection open the whole
time, so a delivery whose handler finishes during that window is acked or
nacked normally, same as any other; only a delivery whose handler is still
running when the process is actually killed gets redelivered. No in-process
test can tell these two outcomes apart — both leave `abandoned: 1` in the
kernel's own report — which is why this package's own suite pins only the
half it can observe: the prompt release, not the eventual disposition. See
`releasedBy`'s TSDoc in `src/amqp-runtime.ts` for the full reasoning.

## The unit boundary

One unit per **delivery**. `UnitMeta.id` is a minted `randomUUID()`, and
`traceId` is the publisher's `messageId` (falling back to `correlationId`,
then to the minted id).

A delivery tag looks like the obvious `id` and is not one: tags are
per-**channel** and restart at `1` after a reconnect, which
`amqp-connection-manager` performs silently underneath this worker — so two
deliveries on either side of a reconnect can carry the same tag.
`consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
caller pin their own `consumerTag`. Minting is the only form of the rule that
survives every case, the same answer `@btravstack/http` reaches per request.

## Writing a runtime

Two contracts a runtime owes the kernel, neither of them checkable, both
discharged here:

1. **The response must be flushed inside the unit.** A delivery's ack or
   nack happens inside `next()` — inside the unit the middleware opened —
   because `amqp-contract`'s own dispatch settles it from the handler's
   returned `Result`. There is no seam for a late ack to land in.
2. **`UnitMeta.id` must be unique per unit unless a `traceId` is supplied.**
   A fresh `randomUUID()` per delivery and the publisher's own `messageId` as
   the correlation id — a caller cannot get either wrong by supplying a
   category where an identity was wanted.

## License

MIT
