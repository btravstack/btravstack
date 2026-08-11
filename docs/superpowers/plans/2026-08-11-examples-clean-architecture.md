# Clean-architecture `examples/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dependency-free `examples/http-api` with a clean-architecture slice across the btravstack stack — five workspace packages, one per layer, booting the same application under two runtimes.

**Architecture:** `order-domain` → `order-application` (ports + use cases) → `order-infrastructure` (Prisma adapter) → `order-api` (oRPC runtime) and `order-worker` (queue runtime). The package boundary is what enforces the dependency direction: domain importing infrastructure must not compile.

**Tech Stack:** TypeScript 7.0.2, `unthrown`, `@btravstack/di`, `@btravstack/start`, `@unthrown/prisma` + `@prisma/client` 7 over in-memory SQLite, `@unthrown/orpc` + `@orpc/server`/`@orpc/client` `2.0.0-beta.23`, vitest.

## Global Constraints

- Every example package is `private: true`. No changeset, nothing published.
- **The kernel's zero-dependency rule binds `packages/start` only.** Examples may take real dependencies — that is the point. `packages/start/` must have ZERO diff across this whole plan; if you believe a kernel change is required, STOP and report BLOCKED.
- **oRPC must be pinned to `2.0.0-beta.23` in the catalog.** `@unthrown/orpc` peers on `^2.0.0-beta`, and oRPC's `latest` dist-tag is the 1.x line, so `latest` resolves 1.15.0 and fails this repo's `strictPeerDependencies: true`.
- **No Docker, no network, no external services.** Prisma runs on in-memory SQLite via `@prisma/adapter-better-sqlite3`.
- TypeScript strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; ESM-first; NodeNext — relative imports end in `.js`.
- oxlint binding: no `interface` (use `type`), no `any` (use `unknown`). `@unthrown/oxlint` recommended rules apply, including `no-unhandled-result` and `no-catch-all-pattern` — **every error case named, no `P._`**. A targeted `oxlint-disable` must carry a reason.
- Comment density SPARSE. NO COMMENTS IN JSON FILES. Conventional commits.
- The full repo gate stays green at every task: `pnpm format --check`, `pnpm lint`, `pnpm typecheck`, `pnpm knip`, `pnpm test`, `pnpm build`.
- Package naming `@btravstack/start-example-<dir>`, matching `@btravstack/di-example-*`.
- The generated Prisma client is **gitignored**; every script that needs it runs `prisma generate` first, the pattern `@unthrown/prisma`'s own `package.json` uses (`"test": "prisma generate && vitest run"`).

## Reference material — read, do not guess

- Layer split and package shape: `/Users/btravers/Projects/btravstack/entity/examples/billing-*/`
- di conventions: `/Users/btravers/Projects/btravstack/di/examples/*/`
- Prisma-over-SQLite wiring, schema and test setup: `/Users/btravers/Projects/btravstack/unthrown/packages/prisma/`
- oRPC bridge usage: `/Users/btravers/Projects/btravstack/unthrown/packages/orpc/`
- The kernel's shipped API: `packages/start/src/runtime.ts`, `start.ts`, `index.ts` in this repo.

## The kernel API the runtimes implement

```ts
type Runtime<Needs extends AnyPort> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (
    host: RuntimeHost<Needs>,
  ) => AsyncResult<Serving, RuntimeStartFailed>;
};
type RuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
  readonly run: RunUnit<Needs>;
};
type Serving = {
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
};
```

`needs: [SomePort]` gives `Needs = typeof SomePort`. `Serving.drain` returns void — the kernel owns drain accounting. `start(module, options, ...gate)` returns `RunningApp<E>` with `.exited`, `.stop()`, `.requestDrain()`, `.phase()`, `.ready()`, `.probePort()`.

**Known kernel limitation, do not fight it:** there is no channel for a runtime's own bound address (`probePort()` exists only for probes). A runtime binding an ephemeral port must expose it itself — put an `onListening` callback or a `boundPort()` accessor on the runtime object, which is the example's own type. This is a recorded rough edge, not something to fix here.

---

### Task 1: Catalog, `order-domain`, `order-application`

**Files:**

- Modify: `pnpm-workspace.yaml` (catalog entries for the new dependencies)
- Create: `examples/order-domain/{package.json,tsconfig.json,vitest.config.ts,README.md,src/}`
- Create: `examples/order-application/{package.json,tsconfig.json,tsconfig.test-d.json,vitest.config.ts,src/vitest.d.ts,README.md,src/}`
- Test: `examples/order-domain/src/order.spec.ts`, `examples/order-application/src/place-order.spec.ts`

**Interfaces:**

- Produces, from `order-domain`: type `Order`, and the domain errors `OrderNotFound`, `DuplicateOrder` (both `TaggedError`). No di, no ports — this layer knows nothing about wiring.
- Produces, from `order-application`: ports `Logger`, `OrderRepository`, `PlaceOrder`, `FindOrder`; and `ApplicationModule`, which PROVIDES the use-case ports and DOES NOT provide `OrderRepository` (it is an unmet need the infrastructure module satisfies — that is the demonstration).

- [ ] **Step 1: Add catalog entries**

In `pnpm-workspace.yaml`'s `catalog:` block add, keeping alphabetical order:

```yaml
"@orpc/client": 2.0.0-beta.23
"@orpc/contract": 2.0.0-beta.23
"@orpc/server": 2.0.0-beta.23
"@prisma/adapter-better-sqlite3": 7.9.1
"@prisma/client": 7.9.1
"@unthrown/orpc": 0.1.2
"@unthrown/prisma": 0.2.0
prisma: 7.9.1
```

- [ ] **Step 2: Write the failing domain spec**

`examples/order-domain/src/order.spec.ts` must assert: `placeOrder(id, quantity)` returns `Ok(order)` for a positive quantity and `Err(InvalidQuantity)` for zero or negative. Keep the domain small — an `Order` type, a constructor function returning a `Result`, and the three tagged errors.

- [ ] **Step 3: Run, see it fail, implement `order-domain/src/`**

The whole layer's dependency list is `unthrown`. If you find yourself needing `@btravstack/di` here, stop — ports belong to the application layer.

- [ ] **Step 4: Write the failing application spec**

`examples/order-application/src/place-order.spec.ts` asserts the use case against a **stub** `OrderRepository` provided by a test-only module — proving the application layer is testable with no infrastructure at all. Assert: a successful placement is persisted; a repository `DuplicateOrder` surfaces unchanged; the `Logger` receives a line.

- [ ] **Step 5: Run, see it fail, implement `order-application/src/`**

Ports as classes (`class OrderRepository extends Port("OrderRepository")<{…}> {}`), use cases as providers depending on them, and `ApplicationModule` exporting `PlaceOrder`, `FindOrder`, `Logger`. `OrderRepository` appears in the module's `Needs`, not its `provides`.

The `Logger` adapter reads `currentUnit()` from `@btravstack/start` fresh on every call so trace ids differ per unit. `order-application` therefore depends on `@btravstack/start` for that one import — note it in the README as the single kernel touchpoint in this layer.

- [ ] **Step 6: Layering guard**

`examples/order-application/src/layering.test-d.ts` — a `@ts-expect-error` proving `order-domain` cannot import `order-application` (the wrong-direction import). Verify it is CONSUMED: delete the directive, confirm `test:types` fails, restore. Paste both outputs.

- [ ] **Step 7: Gate and commit**

`pnpm install`, then the full six-command gate. Commit `feat(examples): add the order domain and application layers`.

---

### Task 2: `order-infrastructure` — the Prisma adapter

**Files:**

- Create: `examples/order-infrastructure/{package.json,tsconfig.json,vitest.config.ts,README.md,prisma/schema.prisma,src/}`
- Modify: `.gitignore` (the generated client)
- Test: `examples/order-infrastructure/src/prisma-order-repository.spec.ts`

**Interfaces:**

- Consumes: `OrderRepository`, `Logger` ports and the domain errors from Tasks 1's packages.
- Produces: `PersistenceModule`, providing `OrderRepository` backed by Prisma, and a `makeTestClient()` helper the spec uses.

- [ ] **Step 1: Schema and client generation**

Copy the shape from `/Users/btravers/Projects/btravstack/unthrown/packages/prisma/prisma/schema.prisma` — SQLite provider, `driverAdapters` preview feature if that repo uses it, output path gitignored. One `Order` model with a UNIQUE constraint on the business id, because Task 2's most important assertion depends on a real unique-constraint violation.

`package.json` scripts follow `@unthrown/prisma`'s own: `"test": "prisma generate && vitest run"`, `"typecheck": "prisma generate && tsc --noEmit"`.

Add the generated client directory to the repo `.gitignore`.

- [ ] **Step 2: Write the failing adapter spec**

Against a real in-memory SQLite client (`@prisma/adapter-better-sqlite3`, `file::memory:?cache=shared` or the pattern `@unthrown/prisma`'s suite uses — read it), assert:

1. `save` then `find` round-trips an order.
2. **A duplicate id produces the application's own `DuplicateOrder`, not Prisma's `UniqueConstraintViolation`.** This is the load-bearing assertion of the whole task: `@unthrown/prisma`'s `tryCreate` returns `Err(UniqueConstraintViolation)` (P2002), and the ADAPTER translates it into the application's domain error via an exhaustive `mapErrCases` with every case named. Infrastructure vocabulary must not reach the application layer.
3. `find` on a missing id returns `Err(OrderNotFound)`.
4. A read path has `E = never` in the application's terms — absence is modelled as the domain error, not as an infrastructure failure.

- [ ] **Step 3: Run, see it fail, implement the adapter and `PersistenceModule`**

The provider uses di's `acquire`/`release` arm so the Prisma client is disconnected on scope close — which also demonstrates the kernel's teardown reaching a real resource.

- [ ] **Step 4: Gate and commit**

Full six-command gate; confirm CI would still pass with no Docker. Commit `feat(examples): add the Prisma persistence layer`.

---

### Task 3: `order-api` — the oRPC runtime

**Files:**

- Delete: `examples/http-api/` (entire package)
- Modify: `pnpm-workspace.yaml` if the deleted package is referenced anywhere
- Create: `examples/order-api/{package.json,tsconfig.json,tsconfig.test-d.json,vitest.config.ts,src/vitest.d.ts,README.md,src/}`
- Test: `examples/order-api/src/orpc-runtime.spec.ts`, `examples/order-api/src/needs-gate.test-d.ts`

**Interfaces:**

- Produces: an oRPC contract and router, `orpcRuntime(options): Runtime<typeof OrderRouter>` (or whichever port it needs — it must be NON-EMPTY), and `src/index.ts` composing `ApplicationModule` + `PersistenceModule` and ending in `runMain`.

- [ ] **Step 1: Delete `examples/http-api`**

`git rm -r examples/http-api`. Its `Runtime`-from-scratch role is superseded; its needs-gate proof migrates to this package. Confirm nothing else imports it.

- [ ] **Step 2: Write the failing runtime spec**

Required assertions:

1. A real oRPC call through `RPCHandler` reaches the DI-wired use case and returns the order.
2. **A domain `Err` becomes a typed, inferable `ORPCError`** — the client sees it as a value with its `code`, not a thrown 500. Assert the code and that it is inferable.
3. A `Defect` collapses to `INTERNAL_SERVER_ERROR` — the non-inferable path.
4. Each call runs in its own unit: two calls produce two DIFFERENT trace ids in the `Logger` lines.
5. Draining lets an in-flight call finish; `ExitReport.drain` is exactly `{ inFlightAtStart: 1, completed: 1, abandoned: 0 }`.
6. A hung call with `drainTimeoutMs: 0` yields `abandoned: 1`.
7. Probes answer alongside the runtime: `/livez` 200, `/readyz` 200 while serving, and 503 after `requestDrain()` while in-flight work is still finishing.

Use `port: 0` and `preDrainDelayMs: 0` throughout except where the delay is under test.

- [ ] **Step 3: Run, see it fail, implement the runtime**

`handlerResult` from `@unthrown/orpc/server` adapts a `Result`-returning handler; the `mapErrCases` into `errors.CODE(...)` at the endpoint is the triage point. Every error case named — no `P._`.

The runtime wraps oRPC's `RPCHandler` in a `node:http` server; track sockets so `stop()` cannot hang on keep-alive, and let `drain(signal)` close the listener without killing live sockets. Flush the response INSIDE the unit — responding after `await host.run(...)` races `stop()`'s socket destruction (a hazard proven in the previous iteration).

- [ ] **Step 4: The needs gate, verified not assumed**

`needs-gate.test-d.ts` asserts both directions. Then DELETE the `@ts-expect-error`, re-run `test:types`, confirm it FAILS with the UNSATISFIED RUNTIME NEEDS arity error, restore. Paste both outputs in the report.

- [ ] **Step 5: Gate and commit**

Commit `feat(examples): add the oRPC API layer and remove the node:http example`.

---

### Task 4: `order-worker`, the examples index, and the final gate

**Files:**

- Create: `examples/order-worker/{package.json,tsconfig.json,vitest.config.ts,README.md,src/}`
- Create: `examples/README.md`
- Modify: root `README.md`, `CLAUDE.md` (the examples now exist and are part of the gate)
- Test: `examples/order-worker/src/queue-runtime.spec.ts`

- [ ] **Step 1: Write the failing worker spec**

1. The SAME `ApplicationModule` + `PersistenceModule` composition boots under a different runtime, unchanged.
2. The same `Err` maps to a DIFFERENT transport outcome: `DuplicateOrder` is a dead-letter here, not an `ORPCError`. Assert dead-lettered vs acked.
3. Each job is its own unit — two jobs, two distinct trace ids.
4. Draining waits for the in-flight job: `{ completed: 1, abandoned: 0 }`.

- [ ] **Step 2: Run, see it fail, implement the queue runtime**

In-memory queue, `needs` non-empty, exhaustive named error mapping to ack / retry / dead-letter.

- [ ] **Step 3: Write `examples/README.md` and link it**

Follow `di`'s `examples/README.md` shape. State the layering and the dependency direction, and that these are the only runtimes in the repo with non-empty `needs`.

- [ ] **Step 4: Update `CLAUDE.md`**

The Toolchain section must record that `examples/` is part of the gate, that Prisma's client is generated at test time, and that oRPC is pinned to a beta because `latest` is the 1.x line.

- [ ] **Step 5: Final full gate and commit**

All six commands, plus confirm `pnpm test` runs the example suites. Commit `feat(examples): add the worker deployment and the examples index`.
