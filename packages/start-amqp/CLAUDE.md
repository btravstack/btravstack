# packages/start-amqp

The AMQP consumer runtime's public surface. The root `CLAUDE.md` is the
authoritative spec for the kernel and the conventions; this file holds what only
matters when you are working under `packages/start-amqp/`. Keep it in sync
with the code in the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`amqpRuntime(options)` → `Runtime<Needs, AmqpInfo>`** — runs an
  `@amqp-contract/worker` `TypedAmqpWorker` under the kernel's lifecycle.
  `AmqpOptions<Needs>` — `urls`, `contract` (typed off
  `Parameters<typeof TypedAmqpWorker.create>[0]["contract"]`, never imported by
  name), `handlers`, `middleware`, `needs`, `connectionOptions`,
  `defaultConsumerOptions`, `connectTimeoutMs` (a top-level
  `CreateWorkerOptions` field, **not** nested under `connectionOptions`, where
  setting it is silently inert — an unreachable broker takes the library's 30s
  default to report without it). `AmqpInfo` is `{ queues }`, published on
  `Serving.info` once consuming.
- **`queuesOf`** derives `AmqpInfo.queues` from `contract.consumers` and
  `contract.rpcs` — sorted, de-duplicated, never a separate option — so
  `Serving.info` cannot disagree with what the worker actually consumes.
- **`handlers`** is a **builder** — `(host: RuntimeHost<Needs>) => Record<…>`
  — because `messageUnits` needs the host and the host does not exist until
  `start` calls the runtime. The package never wraps what it returns, which is
  what makes double-wrapping impossible rather than something to detect.
  `TypedAmqpWorker.create` reports a connection failure on the **defect**
  channel with a `TechnicalError` cause — never a modeled `Err` — and
  `createWorker` calls it inside `.recoverDefect(...)`, turning that defect
  into `Err(RuntimeStartFailed({ runtime: "amqp", cause }))`. Dropping that
  `recoverDefect` is the one-line regression that turns every unreachable
  broker into `runMain` exit `70` where a startup failure earns `1`
  (`amqp-runtime.spec.ts`'s `"reports a broker that will not answer as Err,
not a defect"` guards it).
- **`messageUnits(host)` → `MessageMiddleware<Needs>`** — the one line a
  consumer adds to the `middleware` slot. It opens one kernel unit per
  **delivery** (`id` a minted `randomUUID()`, `traceId` the publisher's
  `messageId` — falling back to `correlationId`, then to the minted id) and
  injects `MessageUnitContext<Needs>` — `{ ctx }` — through `amqp-contract`'s
  own per-message context channel, which is why the deferred per-unit
  `forkScope` will land without an API change. **Pass the type argument** (or
  hoist the call) when a handler reads `context.ctx`: TypeScript infers the
  injected context from the middleware's own type and infers nothing from a
  generic call it is still resolving — and unlike `-temporal`'s single
  `declareActivitiesHandler`, `amqp-contract` splits the handler from the
  middleware into **two independent generic calls**, so `declareHandler<...>`
  needs the same treatment; leaving either bare defaults it to `EmptyContext`.
- **A delivery tag is not a valid unit id.** Tags are per-**channel** and
  restart at `1` after a reconnect, which `amqp-connection-manager` performs
  silently underneath this worker — the one identifier that looks unique per
  delivery is not, across exactly the event this library exists to handle.
  `consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
  caller pin `consumerTag`. Minting is the only form of the rule that
  survives.
- **`amqp-contract` is not a peer.** `@amqp-contract/worker` **is** — the
  package's one value import (`TypedAmqpWorker`) lives here, and bundling it
  cost 344 KB of dist before it moved to peer (1.61 KB after).
  `@opentelemetry/api` is a peer transitively, because `@amqp-contract/worker`
  itself peers on it. `@amqp-contract/contract` stays a devDependency only —
  used to type this package's own tests, never appearing in the published
  type surface — and `MessageMiddleware`'s shape is declared **structurally**
  in `message-units.ts`, the same technique `-temporal`'s `ActivityMiddleware`
  uses, so a consumer who does not import `amqp-contract/contract` never
  inherits it either.
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
- Peer dependencies: `@btravstack/start`, `@btravstack/di`, `unthrown`,
  `@amqp-contract/worker`, `@opentelemetry/api`.
