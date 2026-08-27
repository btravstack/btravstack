# @btravstack/prisma

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

- Updated dependencies [d6c035a]
- Updated dependencies [1427b48]
- Updated dependencies [b905a31]
  - @btravstack/config@0.6.0
  - @btravstack/core@0.6.0
  - @btravstack/di@0.6.0

## 0.5.0

### Minor Changes

- aec5a7a: Remove four pieces of public surface nobody uses.

  **`HasMark<C>` is gone** from `@btravstack/http-server`. It existed for exactly
  one hypothetical consumer — its own TSDoc said so: "exported for tooling over a
  contract — an OpenAPI generator deciding whether to emit `security` at all."
  That generator now exists, and it uses `isAuthenticated` instead, because
  emitting `security` needs the requirements rather than a boolean. Its only other
  references were two type tests asserting `HasMark` against itself.

  **`urlVar` is gone** from `prismaDatabase`. It was added so two databases in one
  application would not collide on `DATABASE_URL`; no application has a second
  database, no spec set it, and the collision it prevented has never happened.

  **The `client` arrow takes only the adapter now**, not `(adapter, url)`. The URL
  was passed for a client that wanted it directly; every documented sample takes
  `(adapter)`. The one place that read it was a spec asserting the URL reached the
  adapter — which now reads it **off the adapter**, a stronger assertion than the
  argument allowed, since it proves the thing that actually reaches Postgres was
  configured.

  **`BootDefaults` and `SubmittedUnit` are no longer exported** from
  `@btravstack/testing`. Both stayed internal types; neither had a consumer
  outside the package, and neither TSDoc named one — which is this repository's
  own bar for a library-facing export.

  Nothing here changes behaviour. Each was flexibility added ahead of a need that
  did not arrive, and three of the four were added within the last week.

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

- b921945: Four consistency fixes across the family, found by auditing the thirteen
  packages against each other rather than each on its own.

  **`@btravstack/mailer`'s telemetry namespace was split down the middle.** The
  counter was `btravstack.mailer.sends` while its span attributes were
  `btravstack.mail.recipients` / `.subject` — two prefixes for one package.
  `cache` and `storage` each use one throughout. It is `mail` now, everywhere:

  |            | before                    | after                        |
  | ---------- | ------------------------- | ---------------------------- |
  | counter    | `btravstack.mailer.sends` | `btravstack.mail.operations` |
  | attributes | `{ outcome }`             | `{ operation, outcome }`     |
  | span       | `mailer.send`             | `mail.send`                  |

  The counter is renamed rather than aliased, and the shape now matches
  `cache.operations`, `storage.operations` and `database.operations` — three said
  `operations` with an `operation` attribute, one said `sends` with neither, so a
  dashboard could not group them. **A dashboard reading the old name needs
  updating**; that is the cost of doing it before more people have one.

  **`@btravstack/di` had no coverage gate.** Every other published package
  enforces 100% lines and functions; the container — the package everything peers
  on — was measured at 99.38% lines and 97.18% functions with nothing failing.
  It has its own `vitest.config.ts` now, which is what `vitest.shared.ts`'s own
  comment says a workspace needing more should do. Three tests close the gap: the
  production early-return in the duplicate-port-id warning, `createScope`'s
  default teardown reporter, and the nullish guards that read a forged `Context`
  as empty. `Context`'s phantom variance marker is `/* v8 ignore */`d, since it is
  uncallable by design and the alternative was a weaker gate on the container.

  **`@btravstack/prisma` had a type-test gate that checked nothing** — a
  `test:types` script and a `tsconfig.test-d.json` with no `*.test-d.ts` file to
  run against, so it passed vacuously. It pins six things now, each with mutual
  assignability so a needs list that GAINS a port fails too: the port carries the
  application's own client type, the port id carries its name, the instrumented
  arm needs exactly `Env | Logger | Meter | Tracer`, `instrumented: false` needs
  exactly `Env`, the error channel is the config's unwrapped, and a client with no
  `$disconnect` is refused.

  It also moves to the `exclude` + chained-`tsc` arrangement `core`, `di`,
  `http-server`, `amqp-worker` and `temporal-worker` already use, rather than the
  one `cache`, `mailer` and `storage` use. Both check the files; only the first
  permits `type _X = Expect<…>` aliases, which `noUnusedLocals` rejects under the
  second.

- Updated dependencies [b921945]
- Updated dependencies [c118a74]
  - @btravstack/di@0.5.0
  - @btravstack/config@0.5.0
  - @btravstack/core@0.5.0

## 0.4.0

### Minor Changes

- 49e4fb4: A Prisma starter: `DATABASE_URL` bound through `Config`, the Postgres driver
  adapter, and a client whose pool is the application scope's.

  ```ts
  const database = prismaDatabase("OrderDatabase")({
    client: (adapter) => new PrismaClient({ adapter }).$extends(unthrownPrisma),
  });
  ```

  `database` carries `config`, `port` and a **resourceful** `provider`; a
  composition root provides the first two and exports the port, and the pool
  closes on every exit path including a boot that fails after it opened.

  **The client arrow is the one thing the package cannot own**, and that is the
  whole shape of the decision. A Prisma client is generated per application from
  its own schema, so there is no client type to ship — which is also why this is
  not `@btravstack/database` with an adapter seam. `cache`, `mailer` and
  `storage` can have a memory adapter and a real one because their port is a
  small fixed interface; a database client is whatever your schema generated, and
  an in-memory adapter for arbitrary SQL is not something anyone can write.

  `@btravstack/prisma` is therefore the first package here named after a vendor.
  The transports are named for their role — `http-server`, `temporal-worker`,
  `amqp-worker` — but "database" has no role-shaped surface to name: what varies
  is the ORM, and pretending otherwise ships thirteen lines of wiring behind a
  package.

  **Instrumented by default**, on the same shape as `cache`, `mailer` and
  `storage`: a `btravstack.database.operations` counter whose `outcome` separates
  `ok` from `error`, and an `error` line when a query rejects.
  `instrumented: false` opts out. This works on a client the package cannot see
  the schema of because `$extends` takes a `query` component and
  `$allModels.$allOperations` intercepts every operation on every model.

  **Engine-level tracing turns itself on**, with nothing to wire at a composition
  root. When `instrumented` is on and `@prisma/instrumentation` is installed, the
  starter enables Prisma's own OpenTelemetry instrumentation:

  ```sh
  pnpm add @prisma/instrumentation
  ```

  That traces the **engine** — the real SQL, the connection acquisition, the
  serialisation — below anything a client-level wrapper can reach. So the wrapper
  emits **no span**: a client-level one would sit beside Prisma's on every query
  carrying strictly less. What it keeps is the pair Prisma's instrumentation does
  not do at all, a metric and an error line.

  `@prisma/instrumentation` is an **optional peer**, loaded by dynamic import — a
  static one would make every consumer install it. An application without it keeps
  the counter and the error line, and the skip is logged at `debug` rather than
  left silent, because telemetry you believe you have and do not is worse than
  none.

  It can be a provider rather than an `--import` preload because
  `@prisma/instrumentation` does not patch modules: `enable()` sets a helper on
  `globalThis` under a versioned key and a client reads it per query, so
  registration order is free. `Tracer` is depended on for its ordering rather than
  its value — `otel()` sets the global tracer provider while building that port,
  so naming it is what puts the SDK up first.

  Not included, deliberately: migrations (a deployment runs `prisma migrate
deploy` before the process starts; an application that migrates at boot races
  its own replicas), transactions (commit boundaries belong to the adapter, and
  `$tryTransaction` is already the primitive), a repository base class, and a
  health contribution — `/readyz` answers from the kernel's phase and has no hook
  to contribute to.

  `examples/order-infrastructure` consumes it, so the gate covers it.

### Patch Changes

- @btravstack/config@0.4.0
  - @btravstack/core@0.4.0
  - @btravstack/di@0.4.0
