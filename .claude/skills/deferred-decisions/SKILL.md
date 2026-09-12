---
name: deferred-decisions
description: Decisions this repository deliberately deferred, declined or has already closed. Read BEFORE proposing a feature, a package, a lint rule or a gate that sounds new — it may be a settled "no", or already shipped. Covers container reaping, the currentUnit() lint rule, traces/metrics in observability, and the doc-samples gate.
---

# Deferred, deliberately

A feature request that matches an entry below is not a new idea. A
struck-through entry has SHIPPED — proposing it again re-proposes work that
exists. An open entry names the trigger that would reopen it; absent that
trigger, the answer is no.

- **Reaping the shared containers.** `withReuse()` deliberately keeps them out
  of Ryuk's hands, so they outlive the run — which is the whole point locally
  and pure waste on an ephemeral CI runner that discards the machine anyway.
  There is no harm today; if it ever matters, the fix is a `CI`-conditional
  `withReuse()` in `internal/test-infra/src/containers.ts`, not a teardown
  that would pull a container out from under a concurrent workspace.
- The `@btravstack/oxlint` rule banning `currentUnit()` outside infrastructure
  adapters (Thesis #2) — it needs a way to identify an adapter.
- ~~Traces and metrics in `@btravstack/observability`.~~ **Closed by
  shipping the shape as written** (issue #64): `Tracer`/`Meter` ports and the
  OTel `NodeSDK` as a resourceful provider whose `release` flushes, behind
  the `@btravstack/observability/otel` subpath on the `pino` optional-peer
  protocol; `UnitSpanModule` as a span per unit through a starter's own bound
  `unit` option;
  W3C `traceparent` honoured inbound by `@btravstack/http-server` and
  `@btravstack/amqp-worker` (trace-id field only — the parent span id is dropped,
  never half-carried), with `@btravstack/temporal-worker` deliberately keeping the
  workflow id as its correlation. A starter's OWN instrumentation is
  graph-owned: it contributes to `Instrumentations` (declared in `core`) and
  `otel()` registers every contribution, so composing `@btravstack/prisma`
  declares engine tracing and composing `otel()` turns it on — nothing
  registers when no SDK is composed. The auto-instrumentation constraint held
  for the PRELOAD alone:
  the preload cannot be DI-provided, so the package ships the graph-owned
  half and the `--import` line stays the deployment's. Surfaces in
  `packages/observability/CLAUDE.md`.
- ~~A `docs-examples.test-d.ts` for `@btravstack/temporal-worker`, `@btravstack/amqp-worker`
  and `@btravstack/observability`.~~ **Closed by the doc-samples gate**
  (issue #94): `docs/scripts/extract-doc-samples.ts` now compiles every `ts`
  fence on the site and in every README under `pnpm typecheck` — see
  **Documentation site**. The trigger had fired again (the amqp and temporal
  READMEs still showed the two-argument `execute` from before the branded
  tenant, a wrong consumer key, and a `DuplicateOrder`-only triage missing
  the `InvalidOrderId`/`InvalidQuantity` arms), and the sweep that built the
  gate fixed a dozen more: pages predating declared `needs`, the slices
  split, `defineHttp`, and di's keyed deps. Regression-proved: reverting the
  temporal README's `execute` to the two-argument form fails `typecheck` with
  `TS2554` naming the README.

  **The HTTP half is no longer deferred**, because that trigger fired twice in
  two days (issues #74 and #75, six pages describing `examples/order-api` as it
  was before it had authentication). `examples/order-api/src/docs-examples.test-d.ts`
  is the gate, and it lives in the **example** rather than in
  `packages/http-server`: the samples call the real `PlaceOrder` / `FindOrder` /
  `FindCustomer` against the real `contract` through the application's own
  `src/auth.ts`, and a stub would have accepted every broken call — passing an
  order id where a tenant goes was exactly the drift. It covers both
  controllers, the composed router, the `HttpModule` root whose authenticators
  ride the router,
  the lifted single-slice root and the bare `api.OrpcRouter(contract)({ inject, unit?, sync })`
  form the three router-shaped pages share — `docs/index.md`,
  `docs/reference/http-server.md` and `docs/how-to/serve-orpc-over-http.md`, none of
  which puts a controller in between. Every deps record it compiles is
  **keyed**, di's one shape since `feat(di)!: a provider declares its
dependencies by name`; a positional array is refused as
  `not assignable to parameter of type 'Readonly<Record<string, AnyPort>>'`,
  which is what several pages outside this gate carried until the
  doc-samples gate swept them.
  It does **not** cover the pages' own contract
  declarations: `zod` and `@btravstack/contract` are
  `examples/order-api-contract`'s dependencies, not `examples/order-api`'s, so
  a fragment is compiled where it lives — though a marker removed from it
  still fails this file, since the controllers are typed by it. No config
  change was needed; the workspace already wires `test:types`.
