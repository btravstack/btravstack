# packages/amqp

The AMQP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters
when you are working under `packages/amqp/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`AmqpModule(name)({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?, connectTimeoutMs?, imports?, provides?, exports? })`**
  (`amqp-module.ts`) — THE way an application declares an AMQP deployment:
  `Module(name)({...})` plus the contract and the handlers **provider**. It
  appends `amqp({ contract, handlers: provider.port, … })` to `imports`,
  prepends the provider to `provides` and `AmqpRuntime` to `exports`, and
  hands the augmented tuples — `Imports<I, HandlersInstance>` / `Provides<P,
HandlersInstance, HandlersError, HandlersNeeds>`, readonly and exact — to
  di's own `Module(name)({...})`, whose return type IS the sugar's: nothing
  spelled twice (di exports `AnyModule`, `AnyProvider`, `Exportable` for the
  tuple constraints; a named generic alias for the return was tried and
  removed — declaration emit keeps it unreduced and cannot name imported
  modules' internal ports, TS2883, measured on `HttpModule`). `handlers` is a
  plain `Provider<HandlersInstance, HandlersError, HandlersNeeds>` whose
  instance is constrained on the type parameter (`HandlersInstance extends
PortInstance<string, WorkerInferHandlers<TContract>>`), so a provider whose
  service is not the contract's handlers fails at the call
  (`amqp-runtime.test-d.ts` pins the sugar's three directions next to the
  primitive's); the port class is read off `provider.port` for the delegation
  (`as never` — the check already happened one level up). The starter it adds
  is typed `Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env |
HandlersInstance>` whether or not `url` is pinned — one declared type, no
  overload pair — so a pinned composition still carries `ConfigInvalid` in its
  error channel (the package's own `App` fixture type is
  `RunningApp<ConfigInvalid, AmqpInfo>` for that reason). Covered by the
  package's own `consuming` fixture, which composes every `serve` /
  `serveBroken` app through it. `AmqpModuleOptions` is
  the exported options type. `AnyAmqpContract` is exported from
  `amqp-runtime.ts` for the sugar's bound, not from `index.ts`.
- **`AmqpHandlers(contract)(name)` → `ReturnType<typeof Provider<PortClassOf<Name, WorkerInferHandlers<C>>>>`**
  (`amqp-runtime.ts`) — the way to the handlers provider `AmqpModule` takes,
  next to it: the first two calls mint the port (`class extends
Port(name)<WorkerInferHandlers<C>> {} as PortClassOf<Name, WorkerInferHandlers<C>>`) and
  return di's own `Provider(port)`, so the last call is exactly
  `Provider(port)(deps, arm)` — any arm, same typing, checked against the
  contract's record before any module sees it — and the provider carries the
  port typed (`provider.port`, di's `& { readonly port: P }`). The class is
  cast to di's `PortClassOf<Name, WorkerInferHandlers<C>>` (`{ portId: Name;
new (): PortInstance<Name, WorkerInferHandlers<C>> }`, the one nameable
  spelling of a minted port class) because the class expression's own type
  expands the brand keys in declaration emit and cannot be named (TS4023,
  measured on `HttpRouter`).
  The contract argument is a value the type alone reads (`_contract`). Same
  shape as `@btravstack/http`'s `HttpRouter(name)` and
  `@btravstack/config`'s `Config.provider(name)(schema)`. A hand-declared port
  plus `Provider(port)(…)` still works everywhere the minted one does. The
  package's fixtures mint `EchoHandlers` through it, and
  `amqp-runtime.test-d.ts` pins that a minted provider satisfies both
  `AmqpModule` and `amqp({ handlers: provider.port })`, and that an arm
  missing a consumer is refused at the `AmqpHandlers` call.
- **`amqp(options)` → `Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env | H>`**
  — the starter, the same shape as `@btravstack/http`'s `http()`. It provides
  the runtime on **`AmqpRuntime`** (`extends RuntimePort<Runtime<never,
AmqpInfo>>` — the runtime has **no** needs) and the broker on
  **`AmqpConfig`** (`{ url }`, bound from `AMQP_URL`, default
  `amqp://127.0.0.1:5672`), and it **needs** the handlers port `H` the
  application provides. The composition root imports it, provides `handlers`,
  exports `AmqpRuntime`; di's own gate checks the need where the root is
  declared, and `start` refuses a module whose needs channel still carries it
  (`examples/order-amqp-worker/src/needs-gate.test-d.ts` pins that
  diagnostic, since `start`'s own gate has no `UNSATISFIED RUNTIME NEEDS` arm
  to fire any more).
  `AmqpOptions<TContract, H>` — `contract: TContract` (`TContract` bounded by
  `Parameters<typeof TypedAmqpWorker.create>[0]["contract"]`, never imported
  by name), `handlers: H & HandlersPort<H, TContract>`, `url?` (pinning it
  yields the narrower `Module<AmqpRuntime | AmqpConfig, never, H>`: no `Env`,
  no `ConfigInvalid`), `connectionOptions`, `defaultConsumerOptions`,
  `connectTimeoutMs` (a top-level `CreateWorkerOptions` field, **not** nested
  under `connectionOptions`, where setting it is silently inert — an
  unreachable broker takes the library's 30s default to report without it).
  `AmqpInfo` is `{ queues }`, published on `Serving.info` once consuming.
- **`handlers` is a PORT whose service is `WorkerInferHandlers<TContract>`** —
  the record `TypedAmqpWorker.create` takes, with **no injected context**.
  `HandlersPort<H, TContract>` is `unknown` when `ServiceOf<H>` is that record
  and `never` otherwise, intersected with `H` at the call site — the same
  trick the oRPC starter's `RouterPort` uses for its router port — so a port
  whose service misses a consumer or names one the contract does not declare
  fails to typecheck at `amqp(...)`, not on the first delivery
  (`amqp-runtime.test-d.ts` pins both directions). Inside, `handlers as
WorkerInferHandlers<TContract>` is **the one cast in the package**: the
  constraint proved it at the call site and `H` alone cannot say so again.
  There is no `needs`, no builder, no `messageUnits(host)` for a consumer to
  place, and no `MessageUnitContext`: a handler is built by di from the
  services its provider declares, and reads nothing out of a context.
- **`queuesOf`** derives `AmqpInfo.queues` from `contract.consumers` and
  `contract.rpcs` — sorted, de-duplicated, never a separate option — so
  `Serving.info` cannot disagree with what the worker actually consumes.
- **`TypedAmqpWorker.create` reports a connection failure on the defect
  channel** with a `TechnicalError` cause — never a modeled `Err` — and
  `createWorker` calls it inside `.recoverDefect(...)`, turning that defect
  into `Err(RuntimeStartFailed({ runtime: "amqp", cause }))`. Dropping that
  `recoverDefect` is the one-line regression that turns every unreachable
  broker into `runMain` exit `70` where a startup failure earns `1`
  (`amqp-runtime.spec.ts`'s `"reports a broker that will not answer as Err,
not a defect"` guards it). `create` never throws synchronously (its own
  handler-record checks come back as defects too), so there is no
  `fromThrowable` around it any more — the builders that could throw are gone
  with `needs`.
- **`messageUnits(host)` is internal** (`message-units.ts`, typed as
  `@amqp-contract/worker`'s own `WorkerMiddleware`, since the peer is already
  there). It opens one kernel unit per **delivery** (`id` a minted
  `randomUUID()`, `traceId` the publisher's `messageId` — falling back to
  `correlationId`, then to the minted id) and calls `next()` **unchanged** — it
  injects nothing. The ambient `currentUnit()` record is what a delivery
  leaves for the adapters that read it, and it is how the package's own suite
  observes the trace id (`seam` in `test-fixtures.ts` records
  `currentUnit()` inside the handler).
- **A delivery tag is not a valid unit id.** Tags are per-**channel** and
  restart at `1` after a reconnect, which `amqp-connection-manager` performs
  silently underneath this worker — the one identifier that looks unique per
  delivery is not, across exactly the event this library exists to handle.
  `consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
  caller pin `consumerTag`. Minting is the only form of the rule that
  survives.
- **`@amqp-contract/worker` is a peer; `@amqp-contract/contract` is not.**
  The package's value imports (`TypedAmqpWorker`) and its public types
  (`WorkerInferHandlers`, through `HandlersPort`) live in `worker`, and
  bundling it cost two orders of magnitude of dist size: 344 KB, measured at
  the commit where it was still bundled, against **~6 KB** peered (`pnpm
--filter @btravstack/amqp build`'s own report — re-measure rather than
  trust this number). `@opentelemetry/api` is a peer transitively, because
  `@amqp-contract/worker` itself peers on it. `@amqp-contract/contract` stays
  a devDependency only — used to type this package's own tests, never
  appearing in the published type surface. `@btravstack/config` is a peer
  since the starter binds `AmqpConfig` through `Config.provider`.
- **The drain has exactly one deadline, and that is the point of the
  package.** `Serving.drain(signal)` calls `worker.close({ drainTimeoutMs:
null })` **raced against `signal`**, and `stop()` reuses whatever deadline
  `drain` armed so a signal-driven shutdown never waits twice. `null` is
  deliberate: the library's own `DEFAULT_DRAIN_TIMEOUT_MS` is 30s, which would
  sit above the kernel's 20s default and quietly win — passing `null` removes
  that second number entirely rather than requiring it be kept under the
  kernel's. When the kernel's deadline wins, `close()` keeps running
  underneath: nothing is dropped, the connection stays open, and the
  in-flight handler keeps heading toward its own ack or nack on the library's
  clock. Redelivery is real, but only once the connection actually drops —
  when the **process** dies, not when the kernel's deadline does — which is
  why the package's own suite pins only the prompt release, not the eventual
  disposition; see `releasedBy`'s TSDoc in `amqp-runtime.ts`.
- **Not included, deliberately**: `Result` → ack / retry / DLQ, which is a
  **three-way** split rather than the library's alone. A modeled
  `RetryableError` / `NonRetryableError` is routed by `amqp-contract`'s own
  dispatch against the queue's `retry` config; a `Defect` is **not** — it is
  nacked once, immediately, under its original routing key, never touching
  that budget — so a handler must recover an infrastructure `Defect` into a
  `RetryableError` itself or "infrastructure comes back" is false on this
  transport. `retry: { mode: "ttl-backoff", maxRetries: 3 }` also means
  **four** total attempts (first plus three retries), not the same count as
  Temporal's `maximumAttempts: 3`.
- **The suite needs Docker** (`@amqp-contract/testing` boots one RabbitMQ per
  run); its fixtures compose `AmqpModule("Consuming")({ contract:
echoContract, handlers, url: amqpConnectionUrl, imports: [AppModule] })`
  with a provider per test from `AmqpHandlers(echoContract)("EchoHandlers")`
  — from `Greeting`, or a value — so the module reads no environment.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`,
  `@btravstack/di`, `unthrown`, `@amqp-contract/worker`, `@opentelemetry/api`.
