# @btravstack/observability

## 0.7.0

### Minor Changes

- 419a9d5: CORS, body limits and response compression are options on `http()` and
  `HttpModule` rather than `plugins` lines — and every framework scalar a
  deployment could reasonably vary is now a configuration field, pinned by its
  option.

  ```ts
  export const OrderApi = HttpModule("OrderApi")({
    router: orderRouter,
    cors: { origin: "https://orders.example", credentials: true },
    bodyLimit: 5_000_000,
    compression: true,
  });
  ```

  `true` takes the underlying oRPC plugin's own defaults; a record is that
  plugin's own options type verbatim — `CORSHandlerPluginOptions`,
  `ResponseCompressionHandlerPluginOptions` — never a `Record<string, unknown>`
  bag. `plugins` stays for every oRPC plugin these three do not name.

  ## Eight new variables, each pinned by its option

  The option is what a test or a settled decision fixes; the variable is what a
  deployment sets. `Config.pinned` decides between them per field — explicit
  beats environment beats default — exactly as `PORT` and `HOST` already worked.

  | Variable                                               | Default           | Bound by                                  |
  | ------------------------------------------------------ | ----------------- | ----------------------------------------- |
  | `PRE_DRAIN_DELAY_MS` / `DRAIN_TIMEOUT_MS`              | `5000` / `20000`  | the kernel                                |
  | `HTTP_BODY_LIMIT`                                      | `1048576`         | `http()` — `0` is unbounded               |
  | `HTTP_CORS_ORIGIN`                                     | unset (off)       | `http()` — a comma-separated list, or `*` |
  | `HTTP_COMPRESSION`                                     | `false`           | `http()`                                  |
  | `TEMPORAL_GRACE_PERIOD_MS` / `TEMPORAL_FORCE_AFTER_MS` | `10000` / `15000` | `temporal()`                              |
  | `AMQP_CONNECT_TIMEOUT_MS`                              | `5000`            | `amqp()`                                  |

  The drain timings are the reason this shape matters: they have to agree with
  the pod's `terminationGracePeriodSeconds`, which lives in the manifest — so
  they belong beside it rather than compiled into the image. The same is true of
  a CORS origin, a body limit and Temporal's shutdown budget.

  **Every variable carries its starter's prefix** — `HTTP_`, `TEMPORAL_`, `AMQP_`,
  `STORAGE_S3_` — because several starters share one process, and a bare
  `BODY_LIMIT` is a name the next starter would also want. The exceptions are
  names the ecosystem already owns and a platform injects (`PORT`, `HOST`,
  `DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `LOG_LEVEL`), plus the kernel's own
  three, since a process has exactly one kernel.

  `@btravstack/config` gains **`Config.boolean`** for the flags: `true`/`false`,
  `1`/`0`, `yes`/`no`, `on`/`off`, case-insensitive. Anything else is an error
  rather than a falsy reading — a deployment that wrote `HTTP_COMPRESSION=enabled`
  meant to turn it on.

  Three things stay composition-time on purpose: a **shape** (`plugins`, a CORS
  record's allowed headers), because an environment carries strings; a **graph
  decision** (`instrumented`), because it changes what is built; and
  `securityHeaders`, because a deployment that can silently turn
  `x-frame-options` off is a footgun the other policies are not.

  ## Consequences
  - `HttpConfig` is `{ port, hostname, bodyLimit, corsOrigin, compression }`,
    `TemporalConfig` gains `{ gracePeriodMs, forceAfterMs }`, and `AmqpConfig`
    gains `{ connectTimeoutMs }`. Anything in the graph may read them.
  - **`AMQP_CONNECT_TIMEOUT_MS` defaults to 5 s where the library defaults to
    30**: thirty seconds is longer than most orchestrators wait before
    restarting the pod, so an unreachable broker is now reported rather than sat
    on.
  - A malformed `PROBE_PORT`, `PRE_DRAIN_DELAY_MS` or `DRAIN_TIMEOUT_MS` is one
    `RuntimeStartFailed` with `runtime: "kernel"` (it was `"probes"`) whose
    `ConfigInvalid` names **every** variable that was wrong — one round trip for
    the operator. A probe _bind_ failure is still `runtime: "probes"`.
  - `HttpOptions`, `TemporalTuning` and `AmqpTuning` are each spelled once and
    intersected into the module sugar's options, which now forwards the whole
    record instead of field by field. An option the sugar forgets to forward can
    no longer exist — which is what this issue was about.

  ## `bodyLimit` defaults on, and the other two default off

  An unbounded body is a trust boundary, where CORS and compression are policy a
  framework guessing is worse than one staying quiet. Over the limit is oRPC's
  `PAYLOAD_TOO_LARGE`, decided on `content-length` when one is sent and while
  streaming otherwise. `bodyLimit: false` — or `BODY_LIMIT=0` — is the previous
  unbounded behaviour.

  `compression` is the **response** half. Request decompression stays a
  `plugins` line: inflating a body before the limit measures it is a decision an
  application should make in the open.

  **CSRF stays a `plugins` line, and the claim was narrowed to say so.**
  `packages/http-server/CLAUDE.md` stated CORS, body limits, compression, CSRF,
  security headers and authentication were all "handler configuration, not a
  middleware slot" while the code shipped that for two of the six. oRPC's CSRF
  protection only bites on a request carrying a `SameSite` cookie, and this
  package configures no cookies, so it becomes an option when they arrive.

### Patch Changes

- Updated dependencies [419a9d5]
  - @btravstack/config@0.7.0
  - @btravstack/core@0.7.0
  - @btravstack/di@0.7.0

## 0.6.0

### Minor Changes

- d6c035a: Health checks: a module declares one, the kernel serves them at `/healthz`.

  ```json
  {
    "status": "unhealthy",
    "components": [
      { "name": "cache", "status": "healthy" },
      {
        "name": "database",
        "status": "unhealthy",
        "reason": "connection refused"
      }
    ]
  }
  ```

  `@btravstack/cache`, `@btravstack/storage` and `@btravstack/prisma` each
  contribute a check. An application composing them wires nothing: one unhealthy
  component makes the whole application unhealthy, and the report names every
  component rather than stopping at the first failure.

  **`Port.many`/`Provider.member` are back in `@btravstack/di`.** They were
  removed because an audit found no consumer — true then, and false as soon as a
  second feature wanted the shape. A set port is what lets a starter DECLARE a
  check rather than register one: a registry the kernel handed out would
  type-check whether or not the call was ever made, so a starter that forgot
  would compile and report healthy forever.

  A set port nobody contributed to now resolves to `[]` rather than throwing —
  the behaviour both di reference pages already documented, and which an
  application composing no starter hits immediately.

  **`/healthz` does not gate `/readyz`.** Readiness removes a pod from its
  Service's endpoints, so failing it on a dependency several replicas share takes
  every replica out at once and turns a degraded system into an outage. The
  kernel reports; an operator decides what a `503` there means.

  `@btravstack/mailer` contributes no check: its port offers only `send`, and a
  probe that delivers mail is not a probe. A cheap `verify()` belongs to the SMTP
  adapter, and can be added there without changing this shape.

  `PrismaLike` now requires `$queryRaw` — every generated Prisma client has it,
  and the check needs the server to answer something rather than trusting a
  pooled client's idea of "connected".

- b905a31: A starter offers its OpenTelemetry instrumentation; composing `otel()` registers it.

  `@btravstack/core` declares an `Instrumentations` set port. A package
  contributes a loader, `() => Promise<unknown>`; `@btravstack/observability/otel` loads every
  contribution and hands it to the `NodeSDK`. Composing a starter **declares**
  what can be instrumented, and composing `otel()` is what turns it on — the
  Spring Boot starter shape, in one port.

  `@btravstack/prisma` is the first contributor. Engine tracing used to be
  enabled while the client was built, whether or not an SDK existed; it is now
  offered, so a graph with no `otel()` never loads `@prisma/instrumentation` at
  all.

  **This does not weaken the preload rule.** `@opentelemetry/auto-instrumentations-node/register`
  still has to be preloaded before the libraries it patches are imported, and no
  provider can promise that. The rule was always about instrumentations that
  patch module loading — one whose `enable()` sets a helper the library reads per
  call has no such ordering requirement, and those are what `otel()` registers.

  `load` is async and answers `undefined` rather than failing, because the
  package supplying the instrumentation is an optional peer the consumer may not
  have installed. The contributor logs the skip, since it is the one that knows
  why.

  `otel()` contributes a member of its own that loads nothing — a collector
  depending on a set port nothing provides is an unmet dependency both at plan
  time and in `Needs`, and Guice's `newSetBinder` declares the empty set for the
  same reason.

  `Tracer` leaves `@btravstack/prisma`'s instrumented `needs`. It was there for
  ordering, to get the SDK up before the instrumentation was enabled; the SDK now
  does the registering, so the ordering is inherent. `Meter` still orders the
  client after `otel()`.

### Patch Changes

- 1427b48: Internal spelling only, no behaviour change: `Ok(v).toAsync()` and
  `Err(e).toAsync()` are now the pre-lifted `OkAsync(v)` / `ErrAsync(e)` the
  repository's own convention asks for, and a nullable lookup is `fromNullable`
  rather than a hand-written ternary.
- 6e99949: `logLevel`'s parse validates with `ensure` and a type guard rather than a
  `flatMap` returning the value it was handed. The narrowing is now proved by the
  predicate instead of asserted twice with `as Level`.
- Updated dependencies [d6c035a]
- Updated dependencies [1427b48]
- Updated dependencies [b905a31]
  - @btravstack/config@0.6.0
  - @btravstack/core@0.6.0
  - @btravstack/di@0.6.0

## 0.5.0

### Minor Changes

- c118a74: Raise the published Node floor to `>=22`, and use `Promise.withResolvers`.

  Node 20 reached end of life on **2026-04-30**. Every line that still receives
  security fixes — 22, 24, 26 — satisfies `>=22`, so this drops a promise rather
  than a supported runtime.

  **The old floor was never provable.** CI runs the dev toolchain, and pnpm 11
  needs `node:sqlite`, which Node 20 does not have — so no job here could ever
  execute the line `>=20` named, and `ci.yml` said so in a comment. The new floor
  sits on the same major as the matrix's `22.22` row, so the promise is exercised.

  The knock-on is `@btravstack/core`'s: `createDeferred` was an eight-line shim
  for a primitive the platform ships as `Promise.withResolvers`, held back only
  by the floor. It is gone, along with `src/deferred.ts`. `Deferred` was never
  exported, so no public surface moves — the only visible change is the
  `engines` field.

  `packages/core` raises its `lib` to `ES2024` for this, alone in the repository
  and commented where it happens; the shared `@btravstack/tsconfig` base stays on
  `ES2023` until a second package needs otherwise.

### Patch Changes

- Updated dependencies [b921945]
- Updated dependencies [c118a74]
  - @btravstack/di@0.5.0
  - @btravstack/config@0.5.0
  - @btravstack/core@0.5.0

## 0.4.0

### Patch Changes

- @btravstack/config@0.4.0
  - @btravstack/core@0.4.0
  - @btravstack/di@0.4.0

## 0.3.0

### Minor Changes

- 6f964fa: A module declares what its own providers expect from outside

  `Module(name)({ … })` takes a fourth list, `needs`. A port **this module's own
  providers** read, and that nothing here satisfies, must be named there; anything
  they owe and it does not name is refused at that call, with the port in the
  message:

  ```
  Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
    '{ provides: [...]; exports: [...]; }' but required in type
    '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
  ```

  Before this, a need nothing local satisfied simply travelled to whoever
  composed the module, and a composition root could satisfy an imported module's
  dependency without that module ever mentioning it — measured: a slice's
  provider received the root's service while importing nothing at all. A slice
  directory could not be read on its own.

  `needs` is the explicit stand-in for NestJS's `@Global`, which this container
  does not have and now does not need: the port is named, the supplier is not, so
  the slice still composes into any root that answers it.

  **An import's own needs are not the importer's to re-declare.** They are already
  published in the import's type, and the entry point still refuses a root that
  has not discharged them — so the declaration lands on the feature that reads the
  port, once, rather than on every module between it and the root. That is
  `ConfigModule.forFeature`'s shape reached without a global: `DatabaseModule`
  says `needs: [Env]` because it reads `DATABASE_URL`, and the persistence modules
  and slices that import it say nothing.

  `Scope` is exempt — nothing can provide it, and the entry point discharges it.

  The three starter sugars — `HttpModule`, `AmqpModule`, `TemporalModule` — take
  `needs` too and re-declare the gate over their augmented tuples, so a
  composition root written with a sugar is checked exactly like a bare
  `Module(name)`.

  `@btravstack/di` additionally exports `NeedsGate` and `Unmet`, which a package
  offering its own shaped module needs in order to re-declare the gate.

- 82579e8: **Breaking.** `Logger`, `Tracer` and `Meter` — and `LoggerService`, `Level`,
  `LEVELS` and `Attributes` with them — are now declared by `@btravstack/core`
  and imported from there. `@btravstack/observability` keeps every
  implementation (`createLogger`, `jsonSink`, `pinoSink`, `observability()`,
  `otel()`, `UnitSpanModule`) and no longer exports the ports; there is no
  re-export, so one contract has exactly one import path.

  A contract that other framework packages depend on has to be reachable
  without installing an implementation, and the kernel is the package all of
  them already peer on. The tracing pair is also declared **without naming
  OpenTelemetry** now — each is a narrowing that a real OTel `Span`, `Tracer`
  and `Meter` satisfies structurally, so the vendor's types stop at the
  `@btravstack/observability/otel` subpath and a port no longer points at an
  implementation.

  To migrate: change the import, not the code.

  ```diff
  -import { Logger } from "@btravstack/observability";
  -import { Meter, Tracer } from "@btravstack/observability/otel";
  +import { Logger, Meter, Tracer } from "@btravstack/core";
   import { observability } from "@btravstack/observability";
   import { otel } from "@btravstack/observability/otel";
  ```

- 4bc4669: The traces-and-metrics half of observability ships, as the deferred design
  prescribed. `@btravstack/observability/otel` — with `@opentelemetry/api` and
  `@opentelemetry/sdk-node` as optional peers, the `pino` protocol — exports
  `Tracer` and `Meter` ports over a `NodeSDK` held as a resourceful provider
  whose `release` flushes (a lost flush is a `teardownError` and exit `2`,
  never silence), and `UnitSpanModule`, a `StartOptions.unit` module opening a
  span per kernel unit with the ambient record's `unitId`/`traceId`/`tenantId`
  as attributes. Configuration is the SDK's own `OTEL_*` conventions — no
  config slice. Inbound, `@btravstack/http-server` and `@btravstack/amqp-worker` honour a
  W3C `traceparent` (trace-id field only, outranking `x-request-id` and
  `messageId`); `@btravstack/temporal-worker` deliberately keeps the workflow id as
  its correlation.
- b8fdee9: The `Unmet` type is gone from `@btravstack/di`

  Its documented purpose — a shaped module re-declaring the gates with it — was
  impossible to serve: declaration emit keeps the alias unreduced, and the
  unreduced form names imported modules' internal ports (TS2883 on the first
  consumer that exports a composition root), which is why every in-repo sugar
  already inlined the computation instead. Inline it; `NeedsGate` is unchanged
  and still exported.

  Internal trims alongside, none of them surface: `@btravstack/http-server` no longer
  memoises scheme ports (di resolves by id, so a fresh class per call is the same
  lookup — measured), and `HasMark`, `authenticatorPort` and `Http.authenticators`
  now carry TSDoc naming the external consumer each exists for, so their lack of
  an in-repo caller stops reading as dead surface.

- d5be140: `Runtime.needs` is `Runtime.resolves`

  Two different `needs` in one framework was one too many. di's `Module` has a
  `needs` — what a composition root supplies it — and the kernel's `Runtime` had
  one too, meaning something else entirely: the ports the runtime reads back out
  of the built application context. They never appear in the same object, which
  is exactly why the collision was easy to miss and easy to misread.

  ```ts
  const runtime: Runtime<typeof Clock> = {
    name: "ticker",
    resolves: [Clock],
    start: (host) => OkAsync(serving),
  };
  ```

  The type parameter is `Resolves` rather than `Needs` throughout —
  `Runtime<Resolves, Info>`, `RuntimeHost<Resolves>`, `RunUnit<Resolves>` — and
  `start`'s gate sentence follows:
  `"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.

  Every shipped runtime declares `resolves: []`, so an application that composes
  `http()` / `temporal()` / `amqp()` and never writes a runtime by hand is
  unaffected. A **hand-rolled** runtime renames one field.

  The array is still never read at run time — it exists so `Resolves` is
  inferable from the value, and `start`'s gate checks it against the module's
  exports.

- 3bf4036: A contract may name a scope only if its scheme can grant it

  `HttpRouter(contract)` now refuses a contract declaring a scope outside the
  vocabulary its scheme's authenticator was minted with, and the diagnostic ends
  on the offending scope:

  ```
  Property '"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"' is
    missing in type 'Authenticated<…, [{ user: ["order:export"] }]>' but required
    in type '{ readonly "UNGRANTABLE SCOPE — …": "order:export"; }'
  ```

  Before this, nothing tied a contract's scope **strings** to what a scheme could
  actually grant. A typo — or a scope asked of a scheme declared with no
  vocabulary at all — compiled, passed every check, and then refused every caller
  on that route with a permanent `403` and no diagnostic anywhere.

  A requirement naming no scopes costs nothing, which is the common case. The
  check is the sibling of the scheme-**name** check di already performs by leaving
  an unknown scheme's port unmet.

### Patch Changes

- 4499df1: A comment earns its line, or it goes

  A quarter of the TypeScript in this repository was comment, and one line in ten
  an inline essay — so a reader looking for the code had to skim past the reasons
  for it. `CLAUDE.md`'s "comment density: sparse" bullet now carries a test: a
  comment earns its line only if it guards a specific line against a plausible
  "simplification", states a symbol's contract as TSDoc, is a directive with a
  reason, or is a `GIVEN`/`WHEN`/`THEN` marker.

  No API changes. What consumers see is the TSDoc these packages ship in their
  declarations: shorter, and stating each symbol's contract rather than the
  history behind it, which lives in the repository and on the documentation site.

- fc38b9a: The README samples compile again — and now cannot stop. Every `ts` fence in
  the package READMEs, the root README and the documentation site is extracted
  into generated type-test modules and compiled by `pnpm typecheck`. The sweep
  that built the gate fixed the drift it found: the amqp and temporal READMEs'
  two-argument `execute` from before the branded tenant, a wrong consumer key,
  a missing error-triage arm, and the pre-`defineHttp` router spelling in the
  root README.
- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.
- 74621a1: Say what the runtime bound. The `serving` event now carries `info` and
  `probePort`.

  The kernel knew every bound port and never said one out loud. `probePort()` and
  `runtimeInfo()` resolved them, both were tested, and neither had a single
  production consumer — an application booted, said `serving`, and did not say
  what it was serving on. So `PORT=0` and `PROBE_PORT=0` were supported and
  unusable: the ephemeral bind is deliberate, but a human running the process had
  no way to learn which port they got, and the feature was reachable only from a
  test holding the `RunningApp`.

  ```ts
  | { readonly type: "serving"
      readonly runtime: string
      readonly info: unknown
      readonly probePort: number | undefined }
  ```

  Additive, so an exhaustive `EventSink` keeps compiling. `info` is `unknown`
  because the kernel does not know a runtime's `Info` at the event union —
  `RuntimeInfoOf<X>` is read off the module at `start`'s call site — and a sink
  is serialising it anyway; a generic `KernelEvent<Info>` would infect
  `EventSink`, `stderrSink` and every adapter for one field none of them reads
  structurally. `probePort` is its own field rather than part of `info`, because
  the probe server is the **kernel's** listener and publishing it as something
  the runtime said would be a small lie.

  `@btravstack/observability`'s `kernelEvents` spreads `info` into the line's
  attributes when it is a plain record, so the three runtimes get `port`,
  `taskQueue` + `namespace` and `queues` on their `serving` line with no
  per-runtime logging code — the point of putting it on the event. The record
  guard is also what keeps a hand-rolled runtime publishing a string from
  costing the line.

  `examples/` drops its hardcoded dev ports for `0`. Pinning `3000` and
  `9000`/`9001`/`9002` was the workaround for this gap, and it broke on parallel
  worktrees — two checkouts running `pnpm dev` collided on all four ports.

  Not included, and declined for the record: auto-increment on a busy port. The
  probe port is a contract with the kubelet, so quietly binding `9001` when
  `9000` is taken means the probe hits nothing and the pod flaps. An occupied
  `PROBE_PORT` is a real misconfiguration and `RuntimeStartFailed` naming
  `"probes"` stays the right answer.

- Updated dependencies [4499df1]
- Updated dependencies [6f964fa]
- Updated dependencies [76f58c4]
- Updated dependencies [41aa1fb]
- Updated dependencies [fc38b9a]
- Updated dependencies [9af980d]
- Updated dependencies [ccdcc32]
- Updated dependencies [82579e8]
- Updated dependencies [f615282]
- Updated dependencies [b8fdee9]
- Updated dependencies [31f70f7]
- Updated dependencies [d5be140]
- Updated dependencies [3bf4036]
- Updated dependencies [74621a1]
  - @btravstack/di@0.3.0
  - @btravstack/config@0.3.0
  - @btravstack/core@0.3.0

## 0.2.0

### Minor Changes

- 18e8943: **`@btravstack/observability`** — observability for the kernel, starting with
  logging.

  `Logger` is a di port over a deliberately strict interface, and every
  difference from NestJS's logger is a defect it does not have: a port rather
  than a class you `new` (no static instance, no `useLogger` reaching past DI),
  `with(attributes)` returning a new logger rather than `setContext` mutating the
  one every caller shares, a flat record of scalars rather than `any` varargs, a
  dedicated `cause` channel (an `Error`'s `message` and `stack` are
  non-enumerable, so `JSON.stringify` alone drops exactly the part worth
  keeping), six fixed levels, and a guarantee that a log call cannot throw — a
  broken sink is swallowed rather than becoming an outage.

  - **Correlation is not the caller's job.** `createLogger` reads
    `currentUnit()` **per call**, so every line written inside a unit carries its
    `traceId`, `unitId` and `tenantId` — one application-scope logger, correct
    for every request, with nothing threaded through the call stack.
  - **`observability({ sink?, level? })`** provides `Logger` and `LoggerConfig`,
    bound from `LOG_LEVEL` (default `info`) and validated once: a level outside
    the six is a `ConfigInvalid` naming the variable, exit `78` under `runMain`,
    rather than a silent fallback.
  - **`jsonSink`** is the default — one JSON object per line on stdout, no
    runtime dependency — with the unit's ids as top-level fields a log backend
    indexes. **`pinoSink`** lives behind the `@btravstack/observability/pino`
    subpath, with `pino` as an optional peer; the level filter stays this
    package's, so there is one filter in the process.
  - **`kernelEvents(logger)`** turns the kernel's nine lifecycle events into log
    lines in that same stream, keeping each event's fields as attributes — pass
    it as `StartOptions.onEvent`.

  Traces and metrics are not here yet; the package is named for the whole because
  logs, traces and metrics share a correlation id, a resource, a config slice and
  a flush-on-shutdown lifecycle.

### Patch Changes

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
