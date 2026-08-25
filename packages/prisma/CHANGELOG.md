# @btravstack/prisma

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
