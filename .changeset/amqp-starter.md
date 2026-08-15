---
"@btravstack/amqp": minor
---

**Breaking.** `@btravstack/amqp` becomes a starter, the same shape as
`@btravstack/http`'s `http()`. `amqp({ contract, handlers, url?, ... })`
returns a module providing the runtime on the new **`AmqpRuntime`** port
(`RuntimePort<Runtime<never, AmqpInfo>>` — the runtime has no needs) and the
broker on **`AmqpConfig`** (`{ url }`, bound from `AMQP_URL`, default
`amqp://127.0.0.1:5672`, unless `url` is pinned — then the module reads no
environment).

`handlers` is a **port** the application provides, whose service is the
handlers record the contract wants with no injected context
(`WorkerInferHandlers<typeof contract>`); it is checked against `contract` at
the `amqp(...)` call. Its provider declares what the handlers need and closes
over it — there is no `context.ctx` any more, and no `needs`.

```ts
class OrderHandlers extends Port("OrderHandlers")<WorkerInferHandlers<typeof orderContract>> {}
const orderHandlers = Provider(OrderHandlers)([Logger], {
  sync: (logger) => ({ orderChanged: declareHandler(orderContract, "orderChanged", ...) }),
});

const Worker = Module("Worker")({
  imports: [AppModule, amqp({ contract: orderContract, handlers: OrderHandlers })],
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
provides the handlers, exports `AmqpRuntime`, and returns exactly the di module
`Module(...)` would have declared over the augmented imports/provides/exports —
sugar over the same primitives, nothing new for the kernel or the gates.
`amqp({ contract, handlers })` stays exported as the primitive it delegates to.

```ts
const Worker = AmqpModule("Worker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [AppModule],
});
```

**`AmqpHandlers(contract)(name)`** mints the handlers port and returns di's
own `Provider(port)`, so the class line goes: the last call is exactly
`Provider(port)(deps, arm)`, checked against the contract's record, and the
provider carries the port typed (`orderHandlers.port`) for `amqp()` or a type
test. **`HandlersPortClass<Name, C>`** is the port's type, exported.

```ts
const orderHandlers = AmqpHandlers(orderContract)("OrderHandlers")([Logger], {
  sync: (logger) => ({ orderChanged: declareHandler(orderContract, "orderChanged", ...) }),
});
```
