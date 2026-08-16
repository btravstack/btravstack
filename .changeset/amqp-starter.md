---
"@btravstack/amqp": minor
---

**Breaking.** `@btravstack/amqp` becomes a starter, the same shape as
`@btravstack/http`'s `http()`. `amqp({ contract, url?, ... })`
returns a module providing the runtime on the new **`AmqpRuntime`** port
(`RuntimePort<Runtime<never, AmqpInfo>>` — the runtime has no needs) and the
broker on **`AmqpConfig`** (`{ url }`, bound from `AMQP_URL`, default
`amqp://127.0.0.1:5672`, unless `url` is pinned — then the module reads
nothing from the environment; its declared `Env` need and `ConfigInvalid`
stay).

The handlers are provided on the **starter's own handlers port** — one id,
`Port("AmqpHandlers")`, framework-owned like `AmqpConfig`, since a consumer
serves one handlers record as it boots one runtime; typed per contract at the
type level, so a provider built for one contract cannot be handed to a module
declaring another — whose service is the handlers record the contract wants
with no injected context (`WorkerInferHandlers<typeof contract>`), checked
against `contract` at the `AmqpHandlers(contract)(…)` call. The starter
**needs** that port, so a composition that imports `amqp({ contract })`
without providing handlers is refused at `start`. Its provider declares what
the handlers need and closes over it — there is no `context.ctx` any more,
and no `needs`.

```ts
const orderHandlers = AmqpHandlers(orderContract)([Logger], {
  sync: (logger) => ({ orderChanged: (message) => … }),
});

const Worker = Module("Worker")({
  imports: [AppModule, amqp({ contract: orderContract })],
  provides: [orderHandlers],
  exports: [AmqpRuntime],
});
```

Gone: `amqpRuntime`, `messageUnits`, `MessageMiddleware`, `MessageUnitContext`,
and `AmqpOptions.needs` / `handlers(host)` / `middleware(host)` / `urls`. The
unit-per-delivery middleware is installed by the starter and injects nothing;
`currentUnit()` still carries the trace id (the publisher's `messageId`).
`@btravstack/config` joins the peer dependencies.

**`AmqpModule(name)({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?, connectTimeoutMs?, imports?, provides?, exports? })`**
is the way an application declares an AMQP deployment: `Module(name)({...})`
plus the contract and the handlers **provider**. It imports the starter,
provides the handlers, exports `AmqpRuntime`, and hands the augmented
imports/provides/exports to di's own `Module(name)({...})`, whose return type
is the sugar's — sugar over the same primitives, nothing new for the kernel or
the gates. `handlers` is a plain `Provider` on the starter's handlers port
for `contract` — what `AmqpHandlers` returns.
`amqp({ contract })` stays exported as the primitive it delegates to.

```ts
const Worker = AmqpModule("Worker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [AppModule],
});
```

**`AmqpHandlers(contract)`** is di's own `Provider(port)` on the starter's
handlers port typed for the contract, so the class line and the name go: the
next call is exactly `Provider(port)(deps, arm)`, checked against the
contract's record — a bare function per consumer, nothing to wrap it in —
and the provider carries the port typed (`orderHandlers.port`, di's
`PortClassOf<"AmqpHandlers", WorkerInferHandlers<C>>`) for a hand-declared
provider or a type test.

```ts
const orderHandlers = AmqpHandlers(orderContract)([Logger], {
  sync: (logger) => ({ orderChanged: (message) => … }),
});
```
