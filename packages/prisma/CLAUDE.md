# packages/prisma

The Prisma starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/prisma/`.

## Public surface

- **`prismaDatabase(name)({ client })` → a MODULE, augmented with `port`**
  (`prisma.ts`) — the whole surface. A composition root writes
  `imports: [database]` and exports `database.port`; the config provider, the
  resourceful client provider, the health member and the instrumentation member
  are inside it and are never the application's business, which is the bargain
  `cache({ adapter })` already makes. It needs `Env` and `Logger`, and exports
  `port`, `HealthChecks` and `Instrumentations`.
  - `client: (adapter: PrismaPg) => C` is **the one thing this
    package cannot own**. A Prisma client is generated per application from its
    own schema, so no client type is shippable — which is also why the
    `@btravstack/cache` shape (a fixed `CacheService`, a memory adapter and a
    real one) does not apply here, and why issue #135's adapter-seam option was
    refused. Applying `@unthrown/prisma`'s extension belongs in this arrow too,
    so the port is typed by exactly what the application will hold.
  - `C` is constrained by **`PrismaLike`** — `{ $disconnect(): Promise<void> }`,
    and nothing more. A generated client satisfies it structurally, and so does
    an extended one, since `$extends` preserves `$disconnect`.

- The port is a cast rather than a class expression, and the provider is
  resourceful with an empty error channel: the comments and TSDoc in
  `prisma.ts` say why.

### `@btravstack/prisma/rls`

- **`tenantScoped(tenant, { setting? })`** — a Prisma client extension pinning
  every statement to `tenant` through a transaction-local
  `set_config(setting, tenant, true)`, so a PostgreSQL row-level-security policy
  reading `current_setting('app.tenant_id', true)` sees it. `setting` defaults
  to `app.tenant_id`, and the policy must read the **same** name: a
  `tenantScoped(tenant, { setting })` whose policy names a different one denies
  every row and every write, which looks exactly like row security working.
  Also exported: `TenantScopedOptions`, and the two types
  that make the override's `tx` nameable, `ScopedTransaction` and
  `ScopedTransactionClient<C>`.
- **Applied last**, and it costs a round trip per unpinned statement:
  `rls.ts`'s TSDoc and `docs/reference/prisma.md` state both.

**No re-entry marker, and none is needed.** The `query` hook is the TOP-LEVEL
`$allOperations` — that is what makes raw SQL pinned too — so it sees the
extension's own `$executeRaw`. Issuing every `set_config` through the
**pre-extension** client is what stops the recursion: that client carries none
of these hooks. The `AsyncLocalStorage` flag the design first called for was
measured to work and then deleted, because a statement inside the override's own
transaction never reaches the hook either — `bare`'s `tx` predates the
extension. The self-referential shape Prisma's own RLS documentation shows does
recurse without bound here, because their example hooks `$allModels`, which
never sees raw SQL.

**`$transaction([...])` is refused**, with a rejected promise carrying
`tenantScoped: $transaction([...]) is unsupported — use the callback form.` — a
rejection rather than a `throw`, which `unthrown/no-throw` bans and which
`$tryTransaction` turns into a `Defect` anyway. The array form cannot be pinned:
the query hook answers a plain `Promise` rather than a `PrismaPromise`, so every
element has already run — each in a wrapping transaction of its own — before
`$transaction` sees the array. Measured, a failing second element left the first
element's row committed where vanilla Prisma rolled it back. A batch that stops
being atomic without saying so is worse than one that refuses.

**The override's type is `this`-polymorphic, and that is what keeps `tx`
typed.** Three casts live in `rls.ts` and each carries a one-line guard comment;
the second is the one with a measurement behind it. Without it the
implementation's own signature is what a consumer sees and every caller's `tx`
becomes an implicit `any` (`TS7006`, reproduced by deleting the cast). The
spike's target for it — `(typeof client)["$transaction"]` — is wrong **here**:
the spike read `Prisma` off a generated client, where that indexed access
carries the schema's own delegates, while this package must read it off
`@prisma/client/extension`, where it resolves to
`Omit<PrismaClientExtends<DefaultArgs>, …>` and `tx.order` stops existing. So the
cast targets `ScopedTransaction`,
`<C, R>(this: C, fn: (tx: ScopedTransactionClient<C>) => Promise<R>)` — the same trick `@unthrown/prisma` uses for `$tryTransaction`,
and the only place the client's type can come from when the starter cannot name
a generated client. It drops the array overload too, so the refusal above is a
compile error before it is a rejected promise.

**The deny list is copied by hand, and `rls.test-d.ts` is what holds the copy
honest.** `ScopedTransactionClient<C>` restates Prisma's own `ITXClientDenyList`
rather than importing it, because a published `.d.ts` naming a type from
`@prisma/client/runtime/client` would need an **optional** peer to resolve for
every consumer, subpath or not. `Omit` of a key that does not exist is silent, so
a copy nothing compares would drift without failing: `tx` would keep offering a
member a transaction can no longer use, or hide one it can — `$transaction`
itself among them. So gate 6 of `rls.test-d.ts` asserts
`ScopedTransactionClient<C>` and `Omit<C, ITXClientDenyList>` are mutually
assignable, importing that type — `import type`, erased at build — from the
path Prisma publishes it on. Dropping one member from the hand-written list
fails `pnpm typecheck` with `TS2322`. `@unthrown/prisma` documents the same
hazard on its own list, and its list is longer, which is why this one carries a
different NAME rather than the same one.

**`isolationLevel?: string` is Prisma's own spelling here, not a widening this
package chose.** `@prisma/client/extension`'s `PrismaClientExtends.$transaction`
declares `options?: { maxWait?; timeout?; isolationLevel?: string }` verbatim;
the enum lives on `Prisma.TransactionIsolationLevel`, which a **generated**
client mints, and `Transaction.IsolationLevel` is declared but not exported from
`@prisma/client/runtime/client` (both checked against 7.10.0). So a consumer
holding a generated client does lose the enum through this override —
`"SERIALIZBLE"` compiles and fails at run time — and there is nothing narrower
to name from a package that cannot see a schema.

**The `@prisma/client` peer is `^7.10.0`, the version everything above was
measured against**, rather than the `^7.0.0` the other two Prisma peers carry:
the deny list is copied from 7.10.0's, and the transaction semantics — a `tx`
carrying the extensions applied before this one, and nothing after — were
verified there and nowhere else.

**Its spec is stubbed, by this package's own rule** (no container, which
`vitest.config.ts` explains), and the stub is
built so the pre-extension-client mechanism is FALSIFIABLE: `StubClient.$extends`
answers a NEW client whose statements route through the captured
`$allOperations`, exactly as Prisma's does, so an extension issuing its own
`set_config` through the client it was handed back recurses. Measured by
mutation: pinning through the extended client fails four of the seven tests with
`RangeError: Maximum call stack size exceeded`. `rls.spec.ts` pins
the MECHANICS — which statements are issued, through which client, in which
order, what the hook hands back, and that the array form rejects — against the
`StubClient`. What it cannot prove is that PostgreSQL then refuses the row, and
that proof is deliberately elsewhere: it needs a `NOSUPERUSER NOBYPASSRLS` role,
`FORCE ROW LEVEL SECURITY` and a policy, all of which are the application's DDL.
It lives in `examples/order-infrastructure`, against the shared container.

## Not included, deliberately

**Transactions**, because commit boundaries belong to the adapter and
`@unthrown/prisma`'s `$tryTransaction` is already the primitive — the `rls`
subpath's `$transaction` override is not a counter-example: it pins the tenant on
the connection the callback runs over and opens no commit boundary of its own.

Migrations and a readiness contribution are not here either: `prisma.ts`'s
TSDoc and the root's **Health checks** section say why.

## Engine tracing is offered, not registered

This package contributes a loader for `@prisma/instrumentation` to
`Instrumentations`
instead of enabling it while the client is built. Composing this starter
declares engine tracing; composing `@btravstack/observability/otel` is what
turns it on, and a graph with no SDK never loads the package at all.

How the wrapper observes a generated client, why it opens no span and re-raises
with `Promise.reject`, why `@prisma/instrumentation` can be a provider at all,
why the specs need no container and what the health probe runs are the TSDoc
and comments of `src/instrument.ts`, `src/tracing.ts`, `vitest.config.ts` and
`src/prisma.ts`.
