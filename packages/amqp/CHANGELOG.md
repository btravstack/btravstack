# @btravstack/amqp

## 0.2.0

### Minor Changes

- f9d48ec: **Breaking.** `@btravstack/amqp` becomes a starter, the same shape as
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

- 2f1974e: The AMQP consumer runtime for `@btravstack/core`.

  `amqpRuntime({ urls, contract, handlers, needs })` runs an `amqp-contract`
  worker under the kernel's lifecycle: one unit per delivery, and a drain where
  the kernel's `drainTimeoutMs` is the only deadline — the library is told to wait
  forever and the kernel's signal is raced against it, so there is no second
  timeout to keep in sync.

  Add `messageUnits(host)` to the worker's middleware and every delivery becomes a
  kernel unit with the application context injected. `@amqp-contract/worker` and
  `@opentelemetry/api` are peer dependencies — install them alongside this
  package; `@amqp-contract/contract` stays a devDependency only, used to type
  this package's own tests and never appearing in the published type surface,
  because the middleware type is declared structurally rather than imported.

  `Result` → ack / retry / DLQ is a three-way split, not a single mapping: a
  modeled `RetryableError` / `NonRetryableError` is routed by `amqp-contract`'s
  own dispatch against the queue's retry policy, and a `Defect` is a third
  channel — dead-lettered on its first attempt, never retried, unless the
  handler recovers it into a `RetryableError` itself.

### Patch Changes

- 068399d: **`UnitRecord` gains `signal: AbortSignal`** — the ambient record is five
  fields now, not four. It is the **very** controller the unit's work callback is
  handed, not a copy: one abort, two ways to reach it, fired at the drain
  deadline or at once on a path that skips the drain.

  The gap it closes: a middleware-shaped runtime opens its unit around a call it
  does not own the arguments of. `@btravstack/temporal`'s `activityUnits` and
  `@btravstack/amqp`'s `messageUnits` both hand the kernel a work callback that
  _is_ the library's `next()`, so an activity or a handler had no parameter to
  receive the signal through and the kernel's `drainTimeoutMs` was unobservable
  from inside the work. Injecting a context the transport's contract does not
  type was the alternative, and it is exactly the hidden-dependency shape `di`
  exists to prevent, so the signal travels on the record instead — data about
  this unit, like `deadline`, with nothing to substitute in a test.
  `@btravstack/http` is unchanged: it still passes the same signal as its
  handler's third parameter.

  What each transport does with it is the transport's own business, and both
  examples are worked:

  - **`examples/order-amqp-worker`** answers a `RetryableError` when
    `currentUnit()?.signal.aborted`, leaving the delivery un-acked so the broker
    hands it to the next worker. This transport has no cancellation of its own —
    a redelivery is recovery, not cancellation.
  - **`examples/order-temporal-worker`**'s `ShippingService.arrange` fails as a
    **defect**, which the platform retries on another worker. The contract's
    `ShippingUnavailable` is a permanent no and would be the wrong error for "we
    ran out of time". Temporal's `Context.current().cancellationSignal` is a
    different clock — workflow-side cancellation, and worker shutdown after
    `shutdownGraceTime` — so the two are honoured together rather than one
    standing in for the other.

- Updated dependencies [f133934]
- Updated dependencies [9ca73c5]
- Updated dependencies [ba815e4]
- Updated dependencies [38d7cd5]
- Updated dependencies [4fa693c]
- Updated dependencies [b56501f]
- Updated dependencies [e616e23]
- Updated dependencies [5a271c0]
- Updated dependencies [72b8fbd]
- Updated dependencies [e950473]
- Updated dependencies [068399d]
  - @btravstack/config@0.2.0
  - @btravstack/core@0.2.0
  - @btravstack/di@0.2.0
