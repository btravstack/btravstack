# examples/

Guidance for the ten example workspaces. The repository-wide theses, the
gate commands and the test conventions live in the root `CLAUDE.md`; what
follows is what is true of `examples/` specifically. `examples/README.md`
is the index of the workspaces themselves.

## The examples are part of the gate

- **`examples/` is part of the gate, not a folder of illustrations.** Every
  workspace runs under the same six commands as the kernel — its specs and its
  `*.test-d.ts` files — so an example that stops compiling, stops linting or
  stops passing fails CI exactly as `packages/core` would. The deployments'
  `needs-gate.test-d.ts` files pin
  **`start`'s** gate (`order-api`, `order-temporal-worker`,
  `order-amqp-worker` — its `NO RUNTIME` arm; `order-api`'s also pins the
  `unit` halves) and
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
  `'{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Logger | OrderRepository | Tenant; }'`
  (it was a rest-tuple arity error printing `Expected 5 arguments, but got 2`
  and nothing else).
  A **fourth** mechanism joined them in #50 and is pinned beside the third:
  di's `NeedsGate`, which fires when a module's OWN provider reads a port
  nothing local satisfies and `needs` does not name it —
  `order-temporal-worker`'s `FulfillmentlessSlice`, printing
  ``'{ readonly "UNDECLARED NEEDS — name it in `needs` (a slice), or import/provide it (a root)": StockService | ShippingService; }'``.
  **Four** mechanisms, easy to conflate — and since #93 every one of them
  prints a name. Do not call the second "di's `UNSATISFIED DEPENDENCIES` gate": an
  earlier revision of this file did, and it is wrong in both halves. `start`'s
  `UNSATISFIED RUNTIME PORTS` arm is pinned only by `packages/core`'s own
  `start.test-d.ts`.
  **The contract says WHICH SCHEMES protect a route, and which
  scopes each must grant; the application's `defineHttp({ authenticators })`
  says WHAT each scheme resolves to.**
  The argument is `packages/contract/CLAUDE.md`'s.
  **Both schemes are the starter's own:** `user`
  is `jwtAuthenticator` with nothing pinned, so `HTTP_JWT_JWKS_URI`,
  `HTTP_JWT_ISSUER` and `HTTP_JWT_AUDIENCE` are a deployment's and an unset one
  fails the boot with the variable named; `service` is `apiKeyAuthenticator`.
  What stays the application's is `principal(claims)`:
  the one place this deployment writes which claim carries a tenant — `tenant`
  here, `tid` on Entra, `org_id` on Auth0 — and the one place the `TenantId`
  brand is claimed on this path. The specs mint real tokens through
  `@btravstack/testing/jwt`'s `localIssuer`, file-scoped, and `boot`'s
  environment carries the three variables off it.
- **Authorization is three layers — root thesis #2 — and `orders.export` is
  where all three meet.** The one written by hand is
  `examples/order-api/src/slices/orders/authorize.ts`, and three things about
  its shape are the point, none of them a framework feature:
  - **`Forbidden` is the application's own tagged error**, folded by the same
    exhaustive `mapErrCases` as every domain error. There is no framework
    `Policy` port, no registry and nothing to register — a rule with one
    consumer is a function, and making it a port would put an authorization
    decision behind an override.
  - **It lives in `order-api`, not in `order-application`**, because its
    `principal` input is protocol-shaped: `Caller` is what the schemes
    `defineHttp` declared resolve to, exported from `auth.ts` as an ALIAS of
    that rather than a hand-written union — so a third scheme is a compile
    error inside the rule that must decide about it. A rule over the domain's
    own vocabulary would belong a layer down.
  - **The rule is a quantity CEILING, not ownership**, and that is a fact about
    this domain rather than a preference: nothing records an order's owner,
    because a worker places orders with nobody behind them. Ownership is the
    rule a reader writes on this same shape once their domain records one.

- **The local loop is `pnpm dev`, and it is the production shape** (issue
  #67): `turbo run dev --filter=./examples/*`, one process per deployment,
  each `tsx watch --env-file=../../.env.dev src/main.ts`, output prefixed by
  workspace. The reasoning against a one-process runner is in the
  `deferred-decisions` skill; what lives here is the mechanics.
  - **`tsx`, because Node alone cannot run these files.** Relative imports
    carry `.js` (`moduleResolution: NodeNext`) and Node's own type stripping
    does not remap `./module.js` to `./module.ts` — measured, it is an
    `ERR_MODULE_NOT_FOUND`. `tsx` was already in the catalog for `docs`; it is
    a devDependency of the three example workspaces, and no new dependency.
  - **`.env.dev` is generated, never committed.** The `dev` task depends on
    `@btravstack/internal-test-infra#dev:env`, which attaches to the **same
    shared containers the specs use** (`withReuse()` — a second set
    would be issue #52's duplication in another hat), runs
    `prisma db migrate` under the same lock as the example's own
    `globalSetup` — as the **owner**, then provisioning `orders_app` and
    writing that role's URL, so `pnpm dev` runs under the same row security
    the specs do — and writes `DATABASE_URL` / `AMQP_URL` /
    `TEMPORAL_ADDRESS` / `REDIS_URL` / `SMTP_URL` / `STORAGE_S3_*` /
    `HTTP_JWT_*` / `HTTP_OIDC_*` / `HTTP_SESSION_KEYS`. They are written to a
    file rather than defaulted
    because the ports are whatever Docker mapped, and an ephemeral mapped
    port cannot be a default. `--env-file` is Node's own; no `dotenv`.
  - **`PROBE_PORT` is `0` in each `dev` script**:
    `PROBE_PORT` defaults to `9000` for every application, so on one machine
    all but one of them would fail with `RuntimeStartFailed` for `"probes"` —
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
  - **The root `dev` script is filtered for a reason.** Every package has a
    watch-build `dev` script, and so do `docs` and each example deployment,
    and turbo refuses more persistent tasks than its concurrency — so the
    unfiltered `turbo run dev` the root carried was **already broken** before
    this.

    The package scripts are not dead for being unreachable from the
    root. `dev` depends on `^build`, not `^dev`, so a package's
    `tsdown --watch` is reached only by an explicit
    `pnpm --filter @btravstack/core dev` in a second terminal — which is the
    loop for editing the framework itself against a running example. That
    pairing works because the example resolves the package through a pnpm
    symlink and Node reports the **realpath**, which falls outside
    `tsx watch`'s default `**/node_modules/**` ignore: `tsdown` rewrites the
    package's `dist` and the example reloads. Measured, because an audit
    scanning for callers finds none of these scripts and proposes cutting all
    of them — the consumer is a contributor, not code.

## The example application is multi-tenant

- **The shared database, the `orders_app` role, the row security under `Order`
  and the two tables that are not policed are
  `examples/order-infrastructure/README.md`'s.** What follows is how the
  tenancy reaches each deployment.

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

  **`UnitRecord.tenantId` stays unset by every starter, and no starter has a
  `tenantOf` hook** (root thesis #2): such a hook would answer what establishes
  a tenant and what happens when it is missing on the application's behalf,
  which is the first step of a framework tenancy model that owes many more
  answers than that one.

  The `session` kind is `SessionModule`, `UserModule`'s shape over
  `auth.principals.session` — a browser that logged in is a user, and the one
  line that differs is which principal the `Tenant` is read from. The fragment
  route requires `session` and the JSON procedures keep `user` and `service`,
  which is what lets a cookie and a bearer token stay two credentials for one
  identity. The root composes `sessionCodec()` and
  `...oidc({ principal, scope })` beside `fragmentsLogin: "/auth/login"`, so the
  answerer that seals the cookie and the scheme that reads it hold the same
  keys and the same `principal` the bearer scheme reads its claims with.

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
  three unit modules' `Tenant` providers — `order-api`'s `userAuth`, whose
  `principal` is the one boundary here that **parses before it casts**
  (`TenantIdSchema.safeParse`), because a token claim is the issuer's string
  and no contract validated it; from there the `Identity` carries the brand
  and `UserModule` hands it on uncast;
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

## What each deployment consumes

Each composition root is its deployment's module file —
`examples/order-api/src/module.ts` (`OrderApi`),
`examples/order-temporal-worker/src/module.ts` (`OrderTemporalWorker`) and
`examples/order-amqp-worker/src/module.ts` (`OrderAmqpWorker`) — whose TSDoc
says why it is shaped the way it is; the slice modules, the unit modules and
each deployment's `src/main.ts` carry their own.

- Each metric an application mints sits at an adapter seam, never in the
  application layer — the outbox relay's per-tenant `relayed` counter, the
  billing stand-in's `authorized` counter — and nothing in this application
  measures a request at all: `@btravstack/http-server` reports every one to
  `Observers` at the unit seam, where `otel()`'s member mints
  `btravstack.http.duration` dimensioned by method, answerer, status and
  whether the response was aborted, none of which a request scope can see from
  inside itself.
