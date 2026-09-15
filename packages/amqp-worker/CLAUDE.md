# packages/amqp-worker

The AMQP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters
when you are working under `packages/amqp-worker/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`AmqpModule(name)({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?, connectTimeoutMs?, unit?, imports?, provides?, exports?, needs? })`**
  (`amqp-module.ts`) — THE way an application declares an AMQP deployment:
  `Module(name)({...})` plus the contract and the handlers **provider**. It
  appends `amqp({ contract, … })` to `imports`,
  prepends the provider to `provides` and `AmqpRuntime` to `exports`, and
  hands the augmented tuples — `Imports<I, TContract, Unit>` / `Provides<P,
TContract, HandlersError, HandlersNeeds>`, readonly and exact — to
  di's own `Module(name)({...})`, whose return type IS the sugar's: nothing
  spelled twice (di exports `AnyModule`, `AnyProvider`, `Exportable` for the
  tuple constraints; a named generic alias for the return was tried and
  removed — declaration emit keeps it unreduced and cannot name imported
  modules' internal ports, TS2883, measured on `HttpModule`). `handlers` is a
  plain `Provider<HandlersInstanceOf<TContract>, HandlersError,
HandlersNeeds>` — a provider on the starter's handlers port typed for THIS
  contract, which is what `AmqpHandlers(contract)({ inject, unit?, sync })` returns — so a
  provider whose service is not the contract's handlers fails at the call,
  structurally on the record: one built for another contract is refused
  (`amqp-runtime.test-d.ts` pins it). There is no port to read off it: the
  starter needs its own port, and the sugar's job is to provide it. The
  starter it adds
  is typed `Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env |
HandlersInstanceOf<TContract> | UnitNeedsOf<Unit>>` whether or not `url` is pinned — one declared
  type, no
  overload pair — so a pinned composition still carries `ConfigInvalid` in its
  error channel (the package's own `App` fixture type is
  `RunningApp<ConfigInvalid, AmqpInfo>` for that reason). Covered by the
  package's own `consuming` fixture, which composes every `serve` /
  `serveBroken` app through it. `AmqpModuleOptions` is
  the exported options type. `AnyAmqpContract` is exported from
  `amqp-runtime.ts` for the sugar's bound, not from `index.ts`.
- **`AmqpHandlers(contract)`** takes the contract as a value only its type
  reads. Same shape as `@btravstack/http-server`'s `OrpcRouter(contract)` and
  `@btravstack/temporal-worker`'s `TemporalActivities(contract)` — unlike
  `@btravstack/config`'s `Config.provider(name)(schema)`, which keeps its
  name because several config slices per application is normal. A
  hand-written `Provider(port)(…)` over the same port still works everywhere
  this one does.

- **`AmqpModule` also takes `needs`**, forwarded to di's own — what this
  root's OWN providers expect from outside. The starter's `Env` is not among them: the
  starter is an import, and an import's needs travel without being restated. A
  root that provides a config provider of its own does declare it —
  `examples/order-amqp-worker` says `needs: [Env]` for `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

- **The `context.unit` record is built by a wrapper on the piece, not by the
  middleware**, and that is the decision. `messageUnits` leaves the forked `Context` on the
  dispatcher's context under a symbol; each piece's `sync` return is wrapped
  once, as di constructs it, so a delivery costs one `unitRecordOf` and one
  context object. The alternative — threading a `key → record` map from the
  composing call into `createWorker` — cannot reach a hand-composed
  `amqp({ contract })`, which takes its handlers as a NEED and never sees the
  provider; the record travelling WITH the piece that declared it has no such
  hole. A symbol rather than a name for the same reason
  `@btravstack/http-server` namespaces its own: a handler written against the
  `{ inject, sync }` arm destructures `context`, and an internal key would be
  sitting in it.
  `HANDLER_PREFIX` — the **value** — stays unexported from `index.ts`: an
  application never constructs a port id by hand, so nothing outside this
  package legitimately needs the string. `handler.ts` imports
  `AnyAmqpContract` from `amqp-runtime.ts` with `import type` — erased by
  `verbatimModuleSyntax` — while `amqp-runtime.ts` imports `HANDLER_PREFIX`
  from `handler.ts` as a value, so the two files reference each other in the
  type graph with **no runtime cycle**.

- **`unit?: { message?: Unit }`**, on `AmqpModule` and `amqp()` — the module
  that `messageUnits`, the worker's dispatch middleware, forks around every delivery, **seeded with the
  validated message on `AmqpMessage(contract)`**.
  Built after the message is validated, before the handler runs; torn down
  when the unit closes. There is exactly ONE kind, `message`: a delivery is a
  delivery, where `@btravstack/http-server` has a kind per authentication
  scheme, so no fallback question arises and an unbound `unit` simply forks
  nothing.

- **The first contract a runtime owes — "get the answer out of the process
  inside the unit" — is DELEGATED here, not skipped.** The unit closes when
  `next()` settles, and the ack goes out after it: the middleware does not wrap
  the acknowledgement, because `@amqp-contract/worker` owns it. What keeps the
  contract is the drain — `worker.close()` waits for the deliveries it has
  already taken, and `Serving.stop` waits for that — so the transport is not
  torn down under an ack in flight. Do not "fix" the middleware to wrap the ack:
  it would put the library's own retry and dead-letter routing inside a unit
  whose settling the kernel reads as "this work is finished", and the three-way
  ack/nack/DLQ split is deliberately not this package's (thesis #3).
- **The kernel's per-unit `AbortSignal` rides the ambient `currentUnit()`
  record, and there is no other route to it here.** This transport also has no cancellation story of its own to fall
  back on: an un-acked delivery is **redelivered**, which is recovery, not
  cancellation. So a handler that must stop when the kernel stops waiting reads
  `currentUnit()?.signal`, and what it answers is its own business —
  `examples/order-amqp-worker`'s `orderNotifications` returns a
  `RetryableError`, leaving the delivery un-acked so the broker hands it to
  the next worker.
- **`@amqp-contract/worker` is a peer; `@amqp-contract/contract` is not.**
  The package's value imports (`TypedAmqpWorker`) and its public types
  (`WorkerInferHandlers`, through `HandlersInstanceOf`) live in `worker`, and
  bundling it cost two orders of magnitude of dist size: 344 KB, measured at
  the commit where it was still bundled, against **~6 KB** peered (`pnpm
--filter @btravstack/amqp-worker build`'s own report — re-measure rather than
  trust this number).
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
- **Cross-cutting concerns: the question does not arise here.** There is no
  origin, no preflight and no browser, so CORS and security headers are
  meaningless on this transport, and the connection is already authenticated —
  by the broker, at `url` / `connectionOptions`, before a delivery exists.
  Per-message identity is a **field on the contract's own envelope**, the way
  `tenantId` already is: the same argument-not-ambient trade
  `examples/order-amqp-worker` makes, and nothing this package reads. Limiting
  throughput is **prefetch**, reachable through
  `defaultConsumerOptions` — typed as the library's `ConsumerOptions` since
  issue #25 landed — a different question from this one. `@btravstack/contract` is dependency-free, so its marker combinator
  _would_ work over an AMQP contract; it is deliberately not wired, because
  there is nothing here to authenticate **from**.
