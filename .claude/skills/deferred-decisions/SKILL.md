---
name: deferred-decisions
description: Decisions this repository deliberately deferred, declined or has already closed. Read BEFORE proposing a feature, a package, a lint rule or a gate that sounds new — it may be a settled "no", or already shipped. Covers container reaping, the currentUnit() lint rule, traces/metrics in observability, the doc-samples gate, the one-process dev runner, HTML-means-fragments, transport package naming, the one leaf shape, filtering on a cursor page (declined), and sorting on a cursor page (shipped).
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
  change was needed; the workspace already runs the test-d pass under `typecheck`.

- **The local loop is the production shape, not an exception to it** (issue
  #67). Three deployments meant three terminals, and the tempting fix — a
  kernel API booting all three in one process, which `start` would happily
  support — was measured and declined: it cannot watch (reloading an ESM
  graph in place is a bespoke loader), it shares one event loop and the
  process-global uncaught handlers, so one crash takes all three down and a
  blocking worker starves the API, and it exercises the drain through one
  shared signal instead of three real ones. A dev loop that misrepresents
  failure isolation teaches the wrong lesson about the very thesis it sits
  under. So `pnpm dev` is `turbo run dev --filter=./examples/*`: one process
  per deployment, `tsx watch` on each, output prefixed by workspace — the mechanics are in `examples/CLAUDE.md`.
- **"HTML" here means fragments, and only fragments** (#179's open question).
  Four things were being called HTML support: a template engine's rendered
  pages, an endpoint answering `text/html` for a partial, static assets with
  an SPA fallback, and JSX/SSR with a component model. `htmx()` is the second
  — the one closest to a procedure and hardest to tell apart from one, which
  is why it sharpened the second-answerer question rather than dodging it. The
  first and fourth are #166's rendering layer; the third is #161, and its own
  counter-argument (that it may still be the ingress's job) stands.
- **Each transport package is named for the HALF it implements, and the
  other half's name is reserved.** `http-server`, `temporal-worker` and
  `amqp-worker` — not `http`, `temporal`, `amqp`, which claimed a whole
  transport and delivered the serving side of it. The calling side exists
  today as somebody else's library, used directly by the examples
  (`@orpc/client`, `@temporal-contract/client`, `@amqp-contract/client`),
  and when this family grows its own they take `-client` names beside these.
  Three things decided the spelling:
  - **The neighbours qualify both sides** — `@orpc/server`/`@orpc/client`,
    `@temporal-contract/worker`/`/client` — so an unqualified name reads as
    the umbrella containing both, which is exactly what it is not.
  - **"worker" rather than a uniform `-server`**, because it is Temporal's
    and AMQP's own word, and because `temporal-server` already means the
    Temporal Service — the cluster `internal/test-infra` runs as
    `temporalio/auto-setup`. A name that suggests you are booting the
    cluster is worse than a suffix that varies.
  - **A client will be a PACKAGE, never a subpath.** Peers are per-package,
    so `@btravstack/http-server/client` would drag `@orpc/server` into a
    consumer that only ever calls — the same reason `examples/*-contract`
    are packages of their own: a client must be able to take a contract
    without the server.

  The rename cost nothing because only `@btravstack/di` had ever been
  published (`0.1.0`); after the first release it would have cost a
  deprecation cycle, which is why it happened when it did.

- **The LEAF is one shape, and oRPC's is the one** (issue #207, closed by
  btravstack/temporal-contract#415 and btravstack/amqp-contract#671). A
  developer writes the same function on all three transports: **one record
  carrying everything the invocation has — the input included — and that input
  repeated as a second positional parameter.**

  ```ts
  place:   ({ errors, context, input })      => …   // HTTP, oRPC's own shape
  place:   ({ errors, context, input })      => …   // Temporal
  process: ({ errors, context, raw, input }) => …   // AMQP
  ```

  **oRPC is the reference because it is the most widely used of the three**,
  not because the shape is inherently better: a developer arriving here is more
  likely to have seen it than either of the others, so it is what costs the
  least to match. It is oRPC's shape down to the DUPLICATION — its
  `ProcedureHandlerOptions` carries `input` and its handler still takes it
  positionally — so `({ errors }, input)` remains the same call, and a caller
  picks. The record is what the docs teach, because it is the spelling that
  needs no `_` placeholder when a leaf wants only its input.

  **`input` is the field name on all three**, not `args` or `message`. A local
  synonym per transport would put the relearning back on the one field every
  leaf touches.

  **The convergence happened UPSTREAM, not in an adapter here.** A starter
  could have reshaped the leaf at the call site it already owns, and did not:
  the leaf's type is INFERRED from each contract library's own types, so an
  adapter would re-derive rather than infer it, and it would leave the
  starter's documentation and the library's documentation describing the same
  function with two different signatures. Both libraries are this org's and
  were in beta, so it cost a beta bump rather than a deprecation cycle.

  The AMQP half was the one that was not merely cosmetic: it had no helpers
  record at all, so a handler wanting "infrastructure comes back" imported and
  constructed `RetryableError` by hand. Its record now carries `retryable` and
  `nonRetryable` beside `errors`, so that triage reads like HTTP's — and `raw`,
  the amqplib delivery, which used to be a third parameter no other transport
  had.

  **The naming asymmetry is a separate, smaller decision and is still NOT
  made.** `AmqpHandler`/`AmqpHandlers` differ by one letter, and
  `TemporalWorkflowActivities`/`TemporalActivities` give the piece the longer
  name where HTTP gives the composer a different word entirely
  (`OrpcController`/`OrpcRouter`). The recommendation on the table is HTTP's
  rule — piece and composer get different words, never singular and plural —
  but it renames public API on two packages with no obviously-right
  replacement, so it is recorded here rather than guessed at.

- **Filtering with operators is declined** (issue #261). A normed
  `{ field, op, value }` owes an operator set per type, nesting and null
  handling, and then a translator into Prisma or SQL — a query builder those
  libraries already are, and thesis #8's territory. It has no trigger. A
  listing declaring its own filter fields through `pageRequestOf({
minQuantity })` is the narrow version, and it ships.

  ~~Sorting is deferred with its cursor rule already chosen.~~ **Closed by
  shipping** (issue #261): `sortableBy(item, keys)` is a curated vocabulary
  checked against the item's own schema, `pageRequestOf(filters, {
sortableBy, defaultSort })` takes it beside the filters with `defaultSort`
  required, and a sorted `keyset(request)` answers `SortedKeyset<F> |
CursorRefused` — a union the adapter must branch on, discriminated by
  `resumable`. The cursor rule this entry used to name as decided-but-unbuilt
  is now how it ships: a cursor is valid only for the sort it was issued
  under (`field:direction`, carried verbatim rather than hashed — the
  vocabulary is already public in the emitted document), and a mismatch is
  refused with `reason: "sort-mismatch"`, told apart from an unreadable
  cursor's `"malformed"`. The full position is
  `packages/contract/CLAUDE.md`'s.
