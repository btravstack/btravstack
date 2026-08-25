# packages/amqp-worker

The AMQP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters
when you are working under `packages/amqp-worker/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`AmqpModule(name)({ contract, handlers, url?, connectionOptions?, defaultConsumerOptions?, connectTimeoutMs?, imports?, provides?, exports?, needs? })`**
  (`amqp-module.ts`) — THE way an application declares an AMQP deployment:
  `Module(name)({...})` plus the contract and the handlers **provider**. It
  appends `amqp({ contract, … })` to `imports`,
  prepends the provider to `provides` and `AmqpRuntime` to `exports`, and
  hands the augmented tuples — `Imports<I, TContract>` / `Provides<P,
TContract, HandlersError, HandlersNeeds>`, readonly and exact — to
  di's own `Module(name)({...})`, whose return type IS the sugar's: nothing
  spelled twice (di exports `AnyModule`, `AnyProvider`, `Exportable` for the
  tuple constraints; a named generic alias for the return was tried and
  removed — declaration emit keeps it unreduced and cannot name imported
  modules' internal ports, TS2883, measured on `HttpModule`). `handlers` is a
  plain `Provider<HandlersInstanceOf<TContract>, HandlersError,
HandlersNeeds>` — a provider on the starter's handlers port typed for THIS
  contract, which is what `AmqpHandlers(contract)(deps, arm)` returns — so a
  provider whose service is not the contract's handlers fails at the call,
  structurally on the record: one built for another contract is refused
  (`amqp-runtime.test-d.ts` pins it). There is no port to read off it: the
  starter needs its own port, and the sugar's job is to provide it. The
  starter it adds
  is typed `Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env |
HandlersInstanceOf<TContract>>` whether or not `url` is pinned — one declared
  type, no
  overload pair — so a pinned composition still carries `ConfigInvalid` in its
  error channel (the package's own `App` fixture type is
  `RunningApp<ConfigInvalid, AmqpInfo>` for that reason). Covered by the
  package's own `consuming` fixture, which composes every `serve` /
  `serveBroken` app through it. `AmqpModuleOptions` is
  the exported options type. `AnyAmqpContract` is exported from
  `amqp-runtime.ts` for the sugar's bound, not from `index.ts`.
- **`AmqpHandlersPort` / `HandlersPortOf<C>` / `HandlersInstanceOf<C>`**
  (`amqp-runtime.ts`) — the handlers' port, one id, the starter's own:
  `Port("AmqpHandlers")`, declared once. A consumer serves one handlers record
  as it boots one runtime (thesis #1), so there is nothing to name and the
  port is framework-owned like `AmqpConfig`; two providers for it in one graph
  are di's duplicate-provider defect at build, which is correct. It is
  **generic at the value level and typed per contract at the type level** —
  `HandlersPortOf<C>` is `PortClassOf<"AmqpHandlers", WorkerInferHandlers<C>>`,
  `HandlersInstanceOf<C>` its `PortInstance` — the same move the kernel's
  `RuntimePort` makes, so one `Port(...)` call (no duplicate-id warning
  however many contracts instantiate it) still refuses a provider built for
  one contract handed to a module declaring another. `HandlersPortOf<C>` and
  `HandlersInstanceOf<C>` are **types**, exported from `index.ts` — an
  application that composes `orderHandlers = AmqpHandlers(contract)([piece,
piece])` and exports it by name needs declaration emit to be able to print
  that type, and a type built from an unexported alias fails TS4023
  ("has or is using name 'ID' … but cannot be named") the moment a consumer
  does. `AmqpHandlersPort` — the **value** — stays unexported: nothing outside
  this package legitimately constructs a provider against the bare port (a
  consumer always goes through `AmqpHandlers(contract)` or `AmqpHandler(contract,
key)`, both of which cast it to the typed alias), so there is nothing a
  type-only export would help with.
- **`AmqpHandlers(contract)` → `ReturnType<typeof Provider<HandlersPortOf<C>>>`**
  (`amqp-runtime.ts`) — the way to the handlers provider `AmqpModule` takes,
  next to it: the one call fixes `C` and returns di's own `Provider(port)` on
  `AmqpHandlersPort as HandlersPortOf<C>`, so the next call is exactly
  `Provider(port)({ name: Dep }, arm)` — any arm, same typing, checked against the
  contract's record before any module sees it — and the provider carries the
  port typed (`provider.port`, di's `& { readonly port: P }`, for a
  hand-declared provider or a type test). No name, no class line.
  The contract argument is a value the type alone reads (`_contract`). Same
  shape as `@btravstack/http-server`'s `HttpRouter(contract)` and
  `@btravstack/temporal-worker`'s `TemporalActivities(contract)` — unlike
  `@btravstack/config`'s `Config.provider(name)(schema)`, which keeps its
  name because several config slices per application is normal. A
  hand-written `Provider(port)(…)` over the same port still works everywhere
  this one does. The package's fixtures build every handlers provider off
  `AmqpHandlers(echoContract)`, and `amqp-runtime.test-d.ts` pins that such a
  provider satisfies both `AmqpModule` and a hand-written `Module` importing
  `amqp({ contract })`; that a record missing a consumer, or with a typo'd
  key, is refused at the `AmqpHandlers(contract)(…)` call; that a provider
  built for another contract is refused by `AmqpModule`; and that a
  hand-declared port of another id leaves the starter's need unmet, so
  `start` refuses the module.

  It also takes **`needs`**, forwarded to di's own — what this root's OWN
  providers expect from outside. The starter's `Env` is not among them: the
  starter is an import, and an import's needs travel without being restated. A
  root that provides a config provider of its own does declare it —
  `examples/order-amqp-worker` says `needs: [Env]` for `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

  A third call composes **pieces** instead of a record:
  `AmqpHandlers(contract)([piece, piece, ...])`, one piece per
  `AmqpHandler(contract, key)(deps, arm)`. Its type is an intersection with
  `Compose<C>`, declared **last**: `ReturnType<typeof
Provider<HandlersPortOf<C>>> & Compose<C>` — di's builder first, the composer
  last. Reversed, TypeScript reports the FIRST arm's failure on a
  non-covering array, and the diagnostic degrades to `not assignable to
'Qualification<readonly [], Handlers>'`, naming nothing; last, it reports the
  composing arm's own conditional against `readonly ["UNCOVERED HANDLERS — …",
K]`, which always names the marker — printed as the **bare string**, the
  tuple's element 0, not as the tuple. Measured, not stylistic, and measured
  again for this: the marker sits at the **tail of the third line** of a
  `TS2769`, ~360 characters in on a 444-character line, because TypeScript
  names the source type first and the source is the caller's own piece. The
  missing key `K` itself appears only when the array's length matches that
  marker tuple's own length of 2, and then as a **separate** `TS2769` on the
  trailing element whose target is the bare key (`is not assignable to type
'"c"'`); a single-element array's diagnostic names the marker alone. The
  composed provider's own `deps` are the **piece ports**
  (`InstanceType<T[number]["port"]>` in its return type), not what a piece
  closes over: di constructs each piece first, as its own provider, and the
  composing call declares them under the very key each piece's port id carries
  past `HANDLER_PREFIX` — so the services record IS the handlers record and
  `construct` hands it straight back. That
  means the pieces themselves still need discharging — typically listed in
  `provides` alongside `handlers`, or exported by a slice module imported in
  — the same as any other unmet need; `AmqpModule` does not do this for you,
  it only prepends `handlers` itself. `Uncovered` checks that every key has a
  piece, not that no two share one, so two pieces claiming one key type-check
  together fine. Whether di catches the conflict depends on whether **both**
  end up discharged as providers in the same graph: only then are they two
  providers for one port — di's duplicate-provider defect at build. Wire in
  only one of the two and the other's implementation is simply never
  registered — no diagnostic marks the conflict, and "a consumer belongs to
  exactly one slice" holds only for the slice actually composed in.

- **`AmqpHandler(contract, key)` → `ReturnType<typeof Provider<HandlerPortOf<C, K>>>`**
  (`handler.ts`, exported from `index.ts`) — one consumer or rpc as a
  provider of its own. There is no name to give: the contract key IS the
  port's name, minted as `` `${HANDLER_PREFIX}${key}` `` (`HANDLER_PREFIX =
"AmqpHandler:"`, exported from `handler.ts` only) — so the port id carries
  the key, which is what makes two slices claiming one consumer di's
  duplicate-provider defect rather than a silent merge, and what lets the
  composing form recover each piece's key by stripping the prefix back off
  `piece.port.portId` rather than needing it spelled again. `contract` types
  `key` (`HandlerKeyOf<C>`, `handler.ts`-only, unexported — nothing outside
  this file needs to name a bare key) and the handler
  (`WorkerInferHandlers<C>[K]`); a key the contract does not declare is
  refused at the call — there is nothing to type it by — and a handler whose
  message has drifted is a compile error here, not at the root. The return is
  di's own `Provider(port)`, so every arm is available exactly as it is on
  `AmqpHandlers(contract)`, and the provider carries its port
  (`HandlerPortOf<C, K>`, a **type**, exported from `index.ts` for the same
  declaration-emit reason `HandlersPortOf<C>` is — a slice module that
  exports its own piece by name needs it printable) as `provider.port`.
  `HANDLER_PREFIX` — the **value** — stays unexported from `index.ts`: an
  application never constructs a port id by hand, so nothing outside this
  package legitimately needs the string. `handler.ts` imports
  `AnyAmqpContract` from `amqp-runtime.ts` with `import type` — erased by
  `verbatimModuleSyntax` — while `amqp-runtime.ts` imports `HANDLER_PREFIX`
  from `handler.ts` as a value, so the two files reference each other in the
  type graph with **no runtime cycle**.
- **`amqp(options)` → `Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env | HandlersInstanceOf<TContract>>`**
  — the starter, the same shape as `@btravstack/http-server`'s `http()`. It provides
  the runtime on **`AmqpRuntime`** (`extends RuntimePort<Runtime<never,
AmqpInfo>>` — the runtime resolves **nothing**) and the broker on
  **`AmqpConfig`** (`{ url }`, bound from `AMQP_URL`, default
  `amqp://127.0.0.1:5672`), and it **needs** its handlers port, typed for
  `contract`, which the application provides. The composition root imports
  it, provides the handlers, exports `AmqpRuntime`; di's `Needs` channel
  carries the port, and `start` refuses a module whose needs channel still
  carries it — by assignability against `Env | Scope` on the `module`
  parameter, not by di's `UNSATISFIED DEPENDENCIES` dependency gate, which is why
  the diagnostic ends on
  `Type '"AmqpHandlers"' is not assignable to type '"@di/Scope"'` and names the
  port (`examples/order-amqp-worker/src/needs-gate.test-d.ts` pins that
  diagnostic, since `start`'s own gate has no `UNSATISFIED RUNTIME PORTS` arm
  to fire any more).
  `AmqpOptions<TContract>` — `contract: TContract` (`TContract` bounded by
  `Parameters<typeof TypedAmqpWorker.create>[0]["contract"]`, never imported
  by name; there is no `handlers` option), `url?` (pinning it reads
  nothing from the environment; the declared type stays `Module<AmqpRuntime |
AmqpConfig, ConfigInvalid, Env | HandlersInstanceOf<TContract>>` either way,
  one signature — see the
  sugar entry above), `connectionOptions?: AmqpConnectionOptions` (the
  connection tuning `TypedAmqpWorker.create` accepts — heartbeat, reconnect
  interval, `findServers`, TLS/socket options; the library declares
  `AmqpConnectionManagerOptions` without exporting it by name, so the alias
  reaches it by index, the same trick as `AnyAmqpContract`, and `index.ts`
  exports it so an application can name a config value),
  `defaultConsumerOptions?: ConsumerOptions` (the library's own exported
  type — `prefetch`, `priority`, `arguments`, `consumerTag`, `exclusive`;
  prefetch is the throughput knob). Neither is a `Record<string, unknown>`
  bag any more — issue #25's policy, pinned by `amqp-runtime.test-d.ts`'s
  passthrough block: a key the library does not accept is a compile error at
  the composition root, not a silently ignored setting.
  `connectTimeoutMs` (a top-level `CreateWorkerOptions` field, **not** nested
  under `connectionOptions`, where setting it is silently inert — an
  unreachable broker takes the library's 30s default to report without it).
  `AmqpInfo` is `{ queues }`, published on `Serving.info` once consuming.

- **The handlers port's service is `WorkerInferHandlers<TContract>`** —
  the record `TypedAmqpWorker.create` takes, with **no injected context**.
  Inside, `Provider(AmqpRuntime)({ config: AmqpConfig, handlers:
AmqpHandlersPort as HandlersPortOf<TContract> }, { sync })` — the port rides di, typed for the
  contract, so `sync` reads the record through it and hands it to `create`
  with no cast on the record itself: the former `handlers as
WorkerInferHandlers<TContract>` is gone, and `AmqpHandlersPort as
HandlersPortOf<…>` (here and in `AmqpHandlers`) is the only cast the record
  meets. A record that misses a consumer or names one the contract does not
  declare fails to typecheck at `AmqpHandlers(contract)(…)`, not on the first
  delivery (`amqp-runtime.test-d.ts` pins both directions).
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
- **The kernel's per-unit `AbortSignal` rides that record too, and there is no
  other route to it here.** `host.run` hands one to its work callback, and the
  callback IS `next()` — a handler has no parameter to receive it through, and
  injecting a context the contract does not type was the alternative and was
  rejected. This transport also has no cancellation story of its own to fall
  back on: an un-acked delivery is **redelivered**, which is recovery, not
  cancellation. So a handler that must stop when the kernel stops waiting reads
  `currentUnit()?.signal`, and what it answers is its own business —
  `examples/order-amqp-worker`'s `orderNotifications` returns a
  `RetryableError`, leaving the delivery un-acked so the broker hands it to
  the next worker.
  `amqp-runtime.spec.ts` → _"hands the handler the unit's own AbortSignal,
  through the ambient record"_ pins it, off the `deadline` fixture's handler.
- **A delivery tag is not a valid unit id.** Tags are per-**channel** and
  restart at `1` after a reconnect, which `amqp-connection-manager` performs
  silently underneath this worker — the one identifier that looks unique per
  delivery is not, across exactly the event this library exists to handle.
  `consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
  caller pin `consumerTag`. Minting is the only form of the rule that
  survives.
- **`@amqp-contract/worker` is a peer; `@amqp-contract/contract` is not.**
  The package's value imports (`TypedAmqpWorker`) and its public types
  (`WorkerInferHandlers`, through `HandlersInstanceOf`) live in `worker`, and
  bundling it cost two orders of magnitude of dist size: 344 KB, measured at
  the commit where it was still bundled, against **~6 KB** peered (`pnpm
--filter @btravstack/amqp-worker build`'s own report — re-measure rather than
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
  disposition; see `releasedBy`'s TSDoc in `@btravstack/core`, which is where
  it lives since #24 — this package imports it rather than carrying a copy.
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
- **The suite needs Docker** (`@amqp-contract/testing` boots one RabbitMQ per
  run) and carries **10 specs**: **8** in `amqp-runtime.spec.ts` — one the
  published info, one the unreachable broker, three the unit boundary (_"opens
  one kernel unit per delivery"_, _"refuses a blank message id rather than
  tracing every delivery to it"_, _"builds the handlers from the application's
  own services"_) and three the drain (_"lets an in-flight delivery finish
  while draining"_, _"hands the handler the unit's own AbortSignal, through
  the ambient record"_ off the `deadline` fixture, _"releases the kernel at
  its own deadline, not the library's own close timeout"_) — plus **2** in
  `handler.spec.ts`: a broadcast contract with two consumers of ONE publisher
  on two queues, composed from two pieces via `AmqpHandlers(slicedContract)([left,
right])`, pinning that both slices run (_"serves a record composed from one
  piece per consumer"_) and that each piece closed over only the services its
  OWN provider declared, `left` alone reading `Greeting` (_"builds each piece
  from the ports its own provider declared"_). `handler.test-d.ts` pins the
  composing form's compile-time gates on a contract of its own — a piece typed
  by its own key, an array covering every declared key, an uncovered array
  refused as `@ts-expect-error` (its own single-element case reports only the
  `"UNCOVERED HANDLERS — …"` marker, not the missing key — the comment above
  that gate says so, since the file's own array is one element long; see the
  composing-arm entry above for when the key itself is named), and a piece
  built for another contract
  refused structurally (that contract's own key needs its own message, not a
  reused one, or the two ports are the same type and there is nothing to
  refuse — di's port typing is structural on id and service, not nominal
  across separate `Port()` calls).
  `amqp-runtime.spec.ts`'s fixtures compose `AmqpModule("Consuming")({ contract:
echoContract, handlers, url: amqpConnectionUrl, imports: [AppModule] })`
  with a provider per test from `AmqpHandlers(echoContract)` — from
  `Greeting`, or a value — so the module reads no environment, and hand it to
  the `boot` fixture, `@btravstack/testing`'s `bootFixture()`, which `serve`
  and `serveBroken` depend on: every app is stopped when the test ends, and
  the teardown is Defect-only, so `serveBroken`'s `Err` exit (the unreachable
  broker, `connectTimeoutMs` set short) is the test's own to assert.
  `handler.spec.ts`'s `serveSliced` fixture is the same shape, over
  `AmqpModule("Sliced")({ contract: slicedContract, handlers, provides:
[left, right], url, imports: [AppModule] })` — the two pieces are passed to
  `provides` alongside `handlers` because the composed provider's own `deps`
  are the pieces' ports, which nothing else in the graph would otherwise
  discharge.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`,
  `@btravstack/di`, `unthrown`, `@amqp-contract/worker`, `@opentelemetry/api`.
