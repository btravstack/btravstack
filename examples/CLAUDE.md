# examples/

Guidance for the ten example workspaces. The repository-wide theses, the
gate commands and the test conventions live in the root `CLAUDE.md`; what
follows is what is true of `examples/` specifically. `examples/README.md`
is the index of the workspaces themselves.

## The examples are part of the gate

- **`examples/` is part of the gate, not a folder of illustrations.** All
  ten workspaces run under the same six commands as the kernel — their specs
  plus four `needs-gate.test-d.ts` files, four `layering.test-d.ts` ones and
  `di-hexagonal`'s `index.test-d.ts` —
  so an example that stops compiling, stops linting or stops passing fails CI
  exactly as `packages/core` would. Three of the four needs-gate files pin
  **`start`'s** gate (`order-api`, `order-temporal-worker`,
  `order-amqp-worker` — its `NO RUNTIME` arm, since no starter's runtime
  resolves anything any more; `order-api`'s also pins the `unit` halves) and
  the **unmet need** on the starter's port (a composition importing `http()` /
  `temporal({ contract, workflows })` / `amqp({ contract })` without providing
  the router / activities / handlers carries the starter's port in `Needs`, and
  `start`'s `module` parameter takes only `Scope | Env`, so it fails to assign —
  the starter is an IMPORT, and an import's needs travel without the importer
  re-declaring them, so di's declaration gate has nothing to say and this stays
  the kernel's); the fourth, `order-application`'s, pins **di's**
  `UNSATISFIED DEPENDENCIES` gate on `Module.scoped` — `DependencyGate`, a
  marker on the `module` parameter since issue #93, whose message ends on the
  missing ports:
  `'{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Logger | OrderRepository; }'`
  (it was a rest-tuple arity error printing `Expected 5 arguments, but got 2`
  and nothing else).
  A **fourth** mechanism joined them in #50 and is pinned beside the third:
  di's `NeedsGate`, which fires when a module's OWN provider reads a port
  nothing local satisfies and `needs` does not name it —
  `order-temporal-worker`'s `FulfillmentlessSlice`, printing
  ``'{ readonly "UNDECLARED NEEDS — name it in `needs`": StockService | ShippingService; }'``.
  **Four** mechanisms, easy to conflate — and since #93 every one of them
  prints a name. Do not call the second "di's `UNSATISFIED DEPENDENCIES` gate": an
  earlier revision of this file did, and it is wrong in both halves. `start`'s
  `UNSATISFIED RUNTIME PORTS` arm is pinned only by `packages/core`'s own
  `start.test-d.ts`, since every shipped runtime declares `resolves: []`.
  `examples/` is not the only place the gate is pinned by a **type test**:
  `packages/amqp-worker/src/amqp-runtime.test-d.ts` pins the handlers-port half of
  `amqp`'s own gate, and its sibling `packages/amqp-worker/src/handler.test-d.ts` pins
  the composing form's — a piece typed by the one key it names, and the root's
  array refused when it misses a declared key. `packages/temporal-worker/src/workflow-activities.test-d.ts`
  pins the same shape for `temporal`'s composing form and is that package's
  **first** type test — `packages/temporal-worker` had no `*.test-d.ts` file, and no
  `tsconfig.test-d.json` or `test:types` script, before it. `packages/http-server/src/controller.test-d.ts`
  pins the
  five compile-time gates the composing `OrpcRouter(contract)([...])` form
  owes (see `packages/http-server/CLAUDE.md`). `@btravstack/http-server`'s specs (the
  per-file breakdown and the current total are `packages/http-server/CLAUDE.md`'s own, kept in one
  place rather than restated here) drive the
  transport through `httpServer` with a bare listener, the
  starter proper through `HttpModule`, the composing router and fragments
  forms through the `rpcSliced` and `htmx` fixtures, and the contract marker's
  runtime half — the per-scheme
  authenticator ports and the one middleware they install — through
  `rpcAuthed`. **The contract says WHICH SCHEMES protect a route, and which
  scopes each must grant; the application's `defineHttp({ authenticators })`
  says WHAT each scheme resolves to.**
  `@btravstack/contract` names no identity type at all — `authenticated` takes
  OpenAPI requirements and no type parameter — so nothing about a server's
  view of a caller reaches a client, and a marked fragment reached through
  anything but that one call types `principal: never`, which makes every read a
  compile error and is the signal to use the factory.
  `examples/order-api/src/auth.ts` is the one file per application that names
  its identities, and there is no identity comparison left to make: declaring a
  scheme and implementing it are the same act, so a scheme the contract names
  with no authenticator behind it is di's own unmet need on
  `HttpAuthenticator:<scheme>`. The one call's result is held as **one
  binding and never destructured** — each destructured member expands to a type
  mentioning `@btravstack/contract`'s inaccessible `unique symbol` (TS2527),
  while held whole it collapses to the nameable `Http<A>`, which is why the
  application writes no type annotation at all.
- **The local loop is `pnpm dev`, and it is the production shape** (issue
  #67): `turbo run dev --filter=./examples/*`, one process per deployment,
  each `tsx watch --env-file=../../.env.dev src/main.ts`, output prefixed by
  workspace. The reasoning against a one-process runner is in thesis #1; what
  lives here is the mechanics.
  - **`tsx`, because Node alone cannot run these files.** Relative imports
    carry `.js` (`moduleResolution: NodeNext`) and Node's own type stripping
    does not remap `./module.js` to `./module.ts` — measured, it is an
    `ERR_MODULE_NOT_FOUND`. `tsx` was already in the catalog for `docs`; it is
    a devDependency of the three example workspaces, and no new dependency.
  - **`.env.dev` is generated, never committed.** The `dev` task depends on
    `@btravstack/internal-test-infra#dev:env`, which attaches to the **same
    six shared containers the specs use** (`withReuse()` — a second set
    would be issue #52's duplication in another hat), runs
    `prisma migrate deploy` under the same lock as the example's own
    `globalSetup`, and writes `DATABASE_URL` / `AMQP_URL` /
    `TEMPORAL_ADDRESS` / `REDIS_URL` / `SMTP_URL` / the four `STORAGE_S3_*`. They are written to a file rather than defaulted
    because the ports are whatever Docker mapped, and an ephemeral mapped
    port cannot be a default. `--env-file` is Node's own; no `dotenv`.
  - **`PROBE_PORT` is `0` in each `dev` script, and so is the API's `PORT`**:
    `PROBE_PORT` defaults to `9000` for every application, so on one machine
    two of the three would fail with `RuntimeStartFailed` for `"probes"` —
    the kernel reporting an `EADDRINUSE` correctly, since in production each
    pod has the port to itself. Hardcoding `9000`/`9001`/`9002` fixed that and
    broke on parallel **worktrees**, which this repository uses constantly.
    Since #117 the `serving` event carries the runtime's `info` and the bound
    `probePort`, so an ephemeral bind is readable and there is nothing left to
    collide. Per-app values still live in the per-app script, shared ones in
    `.env.dev`.
  - **`tsx watch` force-kills its child 5 s after a signal**, so a Ctrl-C
    under the watcher can cut beat 3 short — the kernel's own defaults are
    `preDrainDelayMs: 5_000` then up to `drainTimeoutMs: 20_000`. To watch a
    real drain, run the entry point without `watch`. Measured end to end:
    `draining` → `drained` exactly 5.002 s later → `stopping` → `exited 0`.
  - **The root `dev` script is filtered for a reason.** Sixteen workspaces
    have a `dev` script (thirteen packages' watch-builds, `docs`, three examples),
    and turbo refuses more persistent tasks than its concurrency — so the
    unfiltered `turbo run dev` the root carried was **already broken** before
    this, failing on ten persistent tasks against a concurrency of ten.

    The thirteen package scripts are not dead for being unreachable from the
    root. `dev` depends on `^build`, not `^dev`, so a package's
    `tsdown --watch` is reached only by an explicit
    `pnpm --filter @btravstack/core dev` in a second terminal — which is the
    loop for editing the framework itself against a running example. That
    pairing works because the example resolves the package through a pnpm
    symlink and Node reports the **realpath**, which falls outside
    `tsx watch`'s default `**/node_modules/**` ignore: `tsdown` rewrites the
    package's `dist` and the example reloads. Measured, because an audit
    scanning for callers finds none of these scripts and proposes cutting all
    thirteen — the consumer is a contributor, not code.

## The example application is multi-tenant

- **The example application is multi-tenant, and that is why one database
  serves the whole gate.** `examples/order-infrastructure` is PostgreSQL on
  the shared server — a database of its own next to Temporal's — migrated once
  per run by `src/global-setup.ts` with **`prisma migrate deploy`**, the
  command a deployment runs, under the same cross-process lock. Nothing is
  truncated or dropped between tests: each test declares a **tenant** of its
  own (a UUID), so a shared database costs one migration for the whole gate
  instead of one per test, and no test can see another's rows whatever order
  they run in.

  It replaced SQLite **in memory**, which was the right call while every test
  built its own database and stopped being one the moment the gate needed a
  PostgreSQL for Temporal anyway.

  **The tenancy is the APPLICATION's, and it is a capability of the UNIT
  rather than an argument.** `Tenant` is a port `order-application` declares
  (`src/ports.ts`), and each deployment's unit module provides it from
  whatever that unit was opened for: the principal the `user` scheme resolved
  (`order-api`'s `UserModule` in `src/request-scope.ts`), the validated
  activity input (`order-temporal-worker`'s `ActivityUnitModule`), the
  validated delivery (`order-amqp-worker`'s `MessageUnitModule`).
  `OrderTenantPersistence` (`order-infrastructure/src/module.ts`) is composed
  inside the same fork and builds a Prisma repository closed over that tenant,
  so the port it fills and the use cases over it —
  `PlaceOrder.execute(id, quantity)`, `FindOrder.execute(id)`,
  `OrderRepository.find(id)` — have no tenant slot at all. The framework still
  has no concept of one, and no starter reads a tenant off anything.

  **That reverses an earlier revision of this file, which said every port
  names its tenant — and it keeps that revision's argument rather than
  dropping it.** Making the tenant an argument made every CONSUMER of a port
  responsible for a fact the runtime already held: the request that
  authenticated, the attempt that was scheduled, the delivery that arrived
  each knew the tenant before any use case ran, and each new caller had to be
  told again. The claim that a forgotten tenant does not compile still holds,
  one level up — `OrderApplicationModule` names `Tenant` in `needs`, so a root
  composing the orders vertical outside a unit is
  `UNSATISFIED DEPENDENCIES — Tenant`, which `order-application`'s
  `needs-gate.test-d.ts` pins as `TenantlessOrders`. An argument had to be
  remembered per call; the port has to be provided once per unit or nothing
  builds.

  **What keeps a tenant parameter, and why each one does.**
  `CustomerRepository.find` and `FindCustomer.execute` keep theirs: the
  `customers` procedures are **unmarked**, so a request under them forks the
  `anonymous` kind, which has no principal to take a tenant from — the caller
  names it on the input and the controller claims the brand once, with
  `TenantId(input.tenantId)`. `Outbox.pending(tenantId, limit)` keeps its
  own: the relay is a background sweep with no request, delivery or attempt
  behind it, so there is no unit to read one from. `Storage` keys and cache
  keys keep theirs one layer out, because an application service takes plain
  string keys and has no tenant slot to fill. What was the rule is now the
  exception, and each exception names the reason it is one.

  **`Tenant` is a capability in the di `Context`, and `UnitRecord.tenantId`
  stays unset by every starter.** That is thesis #2's own line, on the side
  the thesis puts it: a tenant reached through the ambient store would be a
  dependency no `inject` record names, where a declared port is injected,
  visible in the graph and substitutable in a test — which is what makes a
  missing one a **compile** error rather than an `undefined` at run time or,
  worse, a query that quietly reads another tenant's rows. The record's field
  is still there for a **hand-rolled** runtime whose author has answered what
  establishes a tenant and what happens when it is missing; a starter with a
  `tenantOf` hook would answer both on the application's behalf, which is the
  first step of a framework tenancy model that owes many more answers than
  that one.

  **`order-api` splits `defineHttp` in two, and the tenant is why.**
  `src/auth.ts` binds `auth = defineHttp({ authenticators })` first, then
  `api = auth.units<{ anonymous; user; service }>()` over an `import type` of
  `./request-scope.js`. One call would be mutually recursive: `UserModule`
  names `auth.principals.user` in its own `needs` — that is how a credential
  becomes a `Tenant` inside the graph — so a `defineHttp` naming `UserModule`
  would be defined in terms of a module defined in terms of it (TS7022), and
  `import type` is what keeps the cycle type-level, where TypeScript resolves
  it. The mechanism is `packages/http-server/CLAUDE.md`'s; what belongs here
  is that the second step is the price of taking the tenant off the principal,
  and an application pays it once.

  **The tenant is branded, and the ids beside it are branded on the answer
  side only** (`TenantId` in
  `examples/order-domain/src/tenant.ts`, a `z.uuidv7().brand("TenantId")`).
  Two strings in a fixed order are what the compiler has nothing to say about,
  so `find(id, tenantId)` compiled and queried the wrong tenant; a pair need
  differ in ONE position to become unswappable. The orders half no longer has
  a pair to swap — the unit holds the tenant — so the brand's remaining job is
  the customers half, `find(tenantId, id)` and `execute(tenantId, id)`, and
  `order-application`'s `tenant.test-d.ts` pins exactly that: two positives,
  two `@ts-expect-error` swaps, and a note that dropping `.brand("TenantId")`
  leaves both directives unused. That is why branding every id
  was a separate question — answered separately, in issue #80: **error
  payloads and outputs carry the id's brand, inputs never do.** The domain's
  errors declare `id: OrderId` / `CustomerId` (except the two "as received"
  ids — `InvalidOrderId`'s, which by definition is not one, and the
  contracts' `malformedRef`), and the contracts' refs and views brand their
  `id` slots with the same brand keys, so a customers ref in an orders slot —
  shipped twice in one day, #76 and #77 — is a compile error at the
  controller now. A caller's ergonomics are untouched: the fiction is asked
  only of the server, and a port's `id: string` parameters stay bare, claimed
  by a cast where the error is minted — the same once-per-boundary rule the
  tenant follows. The constructor is a **cast, not a
  parse** — `.parse()` throws, and the value arrived through a contract that
  already validated it — so each path claims the brand exactly once, where an
  outside value becomes the application's vocabulary. **Moving the tenant into
  the unit moved those boundaries too, and shrank them**: they are now the
  three unit modules' `Tenant` providers — `order-api`'s `userAuth`, from
  which the `Identity` carries the brand and `UserModule` hands it on uncast;
  `ActivityUnitModule`'s `TenantId(input.tenantId)`;
  `MessageUnitModule`'s `TenantId(message.payload.tenantId)` — plus the
  customers controller's `TenantId(input.tenantId)` and the relay's
  `tenantsOf`, which brands the `OUTBOX_TENANTS` list once at the config
  boundary. No activity and no handler casts any more: each reads a `Tenant`
  or a use case off `context.unit`, so there is no boundary left inside a leaf
  to claim. `prisma-outbox.ts` is the
  one **read-back** — a row becoming an `OrderEvent` — and so the one place
  the brand is re-applied rather than carried.

  **Every id beside it is a UUIDv7**, declared once on the entity
  (`OrderId`, `CustomerId`) and again on each contract's own schema, so a
  malformed id is refused at the transport before a use case sees it. That
  format is what gave `placeOrder` a **second** way to fail: while the id was
  an unconstrained string the quantity was the only field a typed caller could
  get wrong, so collapsing `Order.make`'s `InvalidEntity` to `InvalidQuantity`
  was sound; with a format it became a mislabelling, and `InvalidOrderId` is
  the arm that fixes it. The two are told apart by **which field** the entity
  named — `Entity.keysOf` over the issue's path — never by the message text,
  and each transport now carries a third arm for it: `BAD_REQUEST` over HTTP,
  a `nonRetryable` `InvalidOrderId` on Temporal, a `NonRetryableError` on the
  queue.

  **A test builds a SCOPE rather than passing an argument, and that is one
  module of machinery — an earlier revision claimed there was none, and there
  now is.** The module is `tenantOf(tenant)`
  (`order-application/src/module.ts`), composed beside the vertical and
  `OrderTenantPersistence`; a fixture that establishes a tenant any other way
  would be establishing one the deployments do not, so what the spec exercises
  is the shape a unit module has. What that buys back is that a cross-tenant
  test is **two scopes over one store**, which is what the isolation the
  shared database rests on actually looks like: `order-application`'s fixtures
  open a second scope over the same `Map`, and `order-infrastructure`'s build
  a second `prismaOrderRepository` over another `TenantId` and assert the first
  cannot see its row.

  **A cache key carries the tenant, and that is the same rule one layer
  out.** `@btravstack/cache`'s `Cache` takes plain string keys — no namespace
  parameter, no tenant slot — because a cache is an application service and
  the framework has no concept of a tenant to put there. So
  `examples/order-api`'s customers controller composes
  `customers:{tenantId}:{id}` by hand, which is the one place the discipline
  is spelled rather than typed: the customers port states it in its signature
  and a unit-bound repository needs no signature at all, where a string key
  can express neither — and the test that proves the read-through reads under
  a tenant of its own for exactly that reason.

  `Outbox.pending(tenantId, limit)` is the case that shows ambient could not
  have covered this anyway: the relay reading it is a background sweep with no
  request, delivery or activity behind it, so there is no unit to read a
  tenant from, ambient or injected. Which tenants it serves is deployment
  configuration (`OUTBOX_TENANTS`), and it sweeps tenant by tenant so one
  tenant's backlog cannot starve another's.

- **The Prisma client is generated at test time, and there is nothing to
  install.** `@btravstack/example-order-infrastructure`'s `generate`
  script writes a gitignored client into `src/generated`, and turbo's `test` /
  `typecheck` / `test:types` tasks carry **both** a `generate` and a
  `^generate` edge — the first so the workspace's own client exists, the second
  so a dependent workspace gets one too. The scripts themselves do **not** call
  `prisma generate`: they did until 2026-08-13, and on a cold cache turbo ran
  the `generate` task and the script's inline copy **concurrently**, which
  fails with `EEXIST: mkdir …/generated/prisma/models`. One generator, ordered
  by the task graph, is what makes that impossible rather than rare.

## What each deployment consumes

- **`examples/order-temporal-worker` consumes `@btravstack/temporal-worker`**, the same
  way `order-api` consumes `@btravstack/http-server`: it supplies the contract, the
  activities provider and the `mapErrCases` triage, and reads `{ taskQueue,
namespace }` back off `Serving.info`. The Worker's lifecycle, the unit per
  attempt and the deadline race are the package's. It is a **two-slice
  modulith**: `FulfillmentSlice`'s `fulfillOrder = TemporalWorkflowActivities(orderContract,
"fulfillOrder")({ inject: { stock: StockService, shipping: ShippingService, storage: Storage },
unit: { place: PlaceOrder, repository: OrderRepository }, sync })` and `BillingSlice`'s
  `chargeOrder = TemporalWorkflowActivities(orderContract,
"chargeOrder")({ inject: { payments: PaymentService }, sync })` are each a **piece** — a provider
  on the port its own contract key mints, closing over only the services its
  own saga calls — and the root composes them,
  `orderActivities = TemporalActivities(orderContract)([fulfillOrder,
chargeOrder])`, into the composition root
  `TemporalModule("OrderTemporalWorker")({ contract, activities:
orderActivities, workflows, imports: [FulfillmentSlice, BillingSlice,
OrderPersistenceModule, storage(…), observability(), otel()], unit: { activity: ActivityUnitModule },
exports: [Tracer, Logger, OrderDatabase] })`, the sugar importing the starter. Neither slice
  imports the orders vertical: `FulfillmentSlice` imports `FulfillmentModule`
  and `BillingSlice` `BillingModule`, and the vertical is composed per attempt
  in `ActivityUnitModule`, over the `Tenant` that attempt's own input names —
  which is why `fulfillOrder` reads `place` and `repository` off
  `context.unit` and only its stand-in services through `inject`. The
  connection and `TEMPORAL_*` come
  from the starter, and `LOG_LEVEL` and the `Logger` the sagas' stand-in
  services write to come from `observability()`. `order-amqp-worker` is the
  same shape — `NotificationsSlice`'s `orderNotifications = AmqpHandler(orderContract,
"orderNotifications")({ inject: { logger: Logger }, sync })` and `AuditSlice`'s `orderAudit =
AmqpHandler(orderContract, "orderAudit")({ inject: { logger: Logger }, sync })`, composed as
  `orderHandlers = AmqpHandlers(orderContract)([orderNotifications,
orderAudit])` — but **neither** slice imports a vertical, and neither does
  the root: a subscriber reacts to a fact somebody else already committed, so
  nothing in this deployment places an order off a message. What stays at the
  root is the persistence the outbox relay reads through
  (`AmqpModule("OrderAmqpWorker")({ contract, handlers: orderHandlers,
imports: [OrderPersistenceModule, NotificationsSlice, AuditSlice, mailer(…),
observability(), otel()], unit: { message: MessageUnitModule },
exports: [Outbox, OrderDatabase, Logger, Tracer], … })`) — a graph with no
  tenant at the root cannot compose the orders vertical there anyway, which is
  the tenancy above showing up as a compile error rather than a convention —
  with its outbox relay a resourceful provider of its own rather than
  something layered onto the runtime — the relay is also the one place in the
  examples that logs a **failure** with nobody to return it to — a sweep has no
  caller — on the port's own
  `(message, attributes?, cause?)` ordering — and it chooses its level per arm
  rather than uniformly: `error` for what is left pending (a message that does
  not fit the contract, a `markPublished` that failed), `warn` for what the
  next sweep takes (a refused publish, an unreadable outbox), each carrying its
  cause as the third argument. Both are also where **honouring the
  kernel's deadline through the ambient record** is worked: neither middleware
  injects anything into the call — `next()` unchanged — so
  `currentUnit()?.signal` is the only route to it, and what each piece answers
  when it is aborted is that **slice's own** business now: `order-amqp-worker`'s
  `orderNotifications` returns a `RetryableError`, leaving the delivery
  un-acked so the broker hands it to the next worker, while `orderAudit` keeps
  writing through the drain window rather than leaving a delivery un-acked;
  `order-temporal-worker`'s `ShippingService.arrange` fails as a **defect**,
  which the platform retries on another worker — the contract's
  `ShippingUnavailable` is a permanent no and would be the wrong error for "we
  ran out of time".
- **`examples/order-api` consumes `@btravstack/http-server` rather than
  hand-rolling a transport, and composes both of the package's answerers: oRPC
  over its own node adapter (`@unthrown/orpc` at the boundary) for the router,
  and htmx fragments for one server-rendered route.** It is a
  two-slice modulith on the shape above: `slices/orders/` and
  `slices/customers/`, each its own contract fragment, its own
  `OrpcController` and its own di module exporting only
  its controller, in di's provider form (`exports: [ordersController]`, since
  `OrpcController` mints the port and there is no class to name; the two
  slices are that form's first call sites). **Only `CustomersSlice` imports a
  vertical** (`CustomerApplicationModule` + `CustomerPersistenceModule`),
  because its procedures are unmarked and its repository is not tenant-bound;
  `OrdersSlice` imports none, since the use cases its pieces read are built
  per request in `UserModule` over the tenant that request authenticated as.
  The orders slice also carries
  `slices/orders/fragment.ts`'s `orderRowFragment` — `api.HtmxGet("/orders/:id/row",
{ requires: [{ user: [] }] })`, minted straight from its method and path with no
  contract in between — reading `FindOrder` off `context.unit` exactly as the
  controller does, so a caller's credential is what scopes the row rather than
  the path, which names only `id`; a cross-tenant test in `fragments.spec.ts`
  renders the slice's own not-found row for a caller whose tenant never placed
  the order.
  One module per vertical in **both**
  layers, not one per layer: a slice, a worker or a unit module carries its own
  vertical and none of the other's. What the graph still shares is the
  internal `DatabaseModule` every persistence module imports: a diamond, not
  duplication, since `build.ts`'s `flatten` collapses the tree into a `Set`
  keyed by provider **reference**, so one `OrderDatabase` is built however many
  modules name it — which is also why `OrderTenantPersistence` **needs** that
  port rather than importing the database module: a fork constructs every
  provider in its own tree, so an import there would open a Prisma client per
  request. The root composes them —
  `orderRouter = api.OrpcRouter(contract)([ordersController,
customersController])` and `orderFragments = api.HtmxFragments([orderRowFragment])`,
  each the composing array form — and
  **`HttpModule("OrderApi")({ router: orderRouter, fragments: orderFragments, unit: { anonymous:
RequestModule, user: UserModule, service: ServiceModule }, imports: [OrdersSlice, CustomersSlice,
OrderPersistenceModule, cache(…), observability(), otel()], exports: [Logger, Tracer, Meter,
OrderDatabase] })`** is the whole
  composition root, a list of slices plus what no slice owns — the
  sugar imports `http()`, provides the router and the fragments provider on the
  starter's own ports and
  exports `HttpRuntime`: `PORT`/`HOST`, `DATABASE_URL` and `REDIS_URL` come from the
  environment inside the graph, the router is mounted under `/rpc` and the
  fragments under `/` — `htmx()`'s own default. It is spelled as
  `orderApiOver(unit)` with `OrderApi = orderApiOver({ anonymous: RequestModule,
user: UserModule, service: ServiceModule })` beside it, and that is a
  **fixture** concession with a reason: `@btravstack/testing`'s `overridden`
  wraps the ROOT, and a unit module is forked later, so a spec has no other
  way to substitute a provider inside `UserModule` — the stub goes in the kind
  and the same one root definition composes it. The root itself stays
  override-free, which is the convention. The
  two authenticators are **not** in that list: they ride the router and the
  fragments provider, which are what need them, and `HttpModule` puts them in
  `provides` itself, deduplicated by reference where both name the same one. The
  **unmarked** `customers` fragment declares `tenantId` on its input, so a
  procedure hands it to the use case and the use case to the repository; the
  **marked** `orders` fragment declares none, and a request under it forks the
  `user` kind, whose `Tenant` comes from the principal — so its leaves name no
  tenant either, they read use cases already bound to one off `context.unit`.
  A caller does not name the tenant it
  is served, and a required field the handler ignores would be a confused
  deputy in contract form. Either way the transport reads nothing about
  tenancy.
  `observability()` is what provides the `Logger` the interactors and the
  request scope write to, and `Logger` is in `exports` because `RequestModule`
  reads it out of the application scope once forked — as `OrderDatabase` is,
  because `UserModule`'s `OrderTenantPersistence` reads the one client from
  there. The three kinds ride
  `HttpModule`'s own `unit` field, so the
  per-request fork is the answerers' — each one opens it around the request it
  is handling, not the kernel's, which forks nothing of its own any more.
  There is no `runtime`, `resolves`,
  `handler`, `port` or env-reading to spell anywhere. Its `main.ts` passes
  `onEvent: kernelEvents(createLogger(jsonSink()))` so the kernel's nine events
  land in the application's own stream, with the logger built by hand because
  `building` is emitted while the graph still is — the kernel's stderr sink
  is a fine default and this is the upgrade, not the requirement. All three
  composition roots bind a unit module on their own runtime options, and every
  one of those modules imports `UnitSpanModule` — `RequestModule` here, which
  the other two kinds import in turn, and `MessageUnitModule` /
  `ActivityUnitModule` on the two workers — so every unit, request or delivery
  or activity attempt, opens an OTel span carrying the same ids the logger
  stamps, and the roots compose `otel()` beside `observability()` and export
  its ports for the fork to read. None of this rides `main.ts` any more — all
  three are the one line `await runMain(<Root>)`, `OrderApi`'s own the sole
  exception, for `onEvent`. Each metric an application mints sits at an adapter
  seam, never in the application layer — the outbox relay's per-tenant
  `relayed` counter, the billing stand-in's `authorized` counter — and nothing
  in this application measures a request at all: `@btravstack/http-server`
  reports every one to `Observers` at the unit seam, where `otel()`'s member
  mints `btravstack.http.duration` dimensioned by method, answerer and status,
  none of which a request scope can see from inside itself. Each procedure is a plain
  `Result`-returning function typed by its slice's fragment (`@unthrown/orpc`'s
  `.result()` handler, wrapped by the router's walk at composition). It reads
  `port` back off
  `Serving.info`; binding, the drain and the trace-id policy are the
  package's. Two gates keep the composition honest at compile time: a root
  that forgets `http()` is refused against
  `"NO RUNTIME — the module exports no port declared over RuntimePort"`, the
  sentence intersected onto `start`'s `module` parameter, and one that imports
  it without providing `orderRouter` leaves `OrpcRouterPort` in `Needs`, which
  the same parameter refuses by assignability — not di's dependency gate.
