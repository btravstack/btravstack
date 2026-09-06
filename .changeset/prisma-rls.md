---
"@btravstack/prisma": minor
---

A new subpath, `@btravstack/prisma/rls`, exporting `tenantScoped(tenant, {
setting })` — a Prisma client extension pinning **every** statement, raw SQL
included, to `tenant` through a transaction-local
`set_config('app.tenant_id', tenant, true)`, so a PostgreSQL row-level-security
policy reading `current_setting('app.tenant_id', true)` sees it. `setting`
defaults to `app.tenant_id`. `@prisma/client` joins the peers as an **optional**
one: nothing on the main entry point imports it, so a consumer that never
imports the subpath installs nothing extra. Its range is `^7.10.0` — narrower
than the `^7.0.0` the adapter and instrumentation peers carry, because that is
the version the transaction deny list was copied from and the only one the
transaction semantics below were measured against.

**Apply it last.** A transaction callback's `tx` comes from the client as it
stood when this extension was applied, so any extension added after it — the
`try*` twins of `@unthrown/prisma` among them — is invisible inside a
transaction. `new PrismaClient({ adapter }).$extends(unthrownPrisma).$extends(tenantScoped(tenant))`.

**`$transaction([...])` is refused**, with a rejected promise carrying
`tenantScoped: $transaction([...]) is unsupported — use the callback form.`, and
the array form is absent from the type as well. The batch cannot be pinned
atomically here: every element has already run, each in a wrapping transaction of
its own, before `$transaction` receives the array — a batch that stopped rolling
back without saying so is worse than one that refuses. Use the callback form.

**The database half stays the deployment's obligation.** The extension sets a
run-time setting; nothing more. The role the application connects as must be
`NOSUPERUSER NOBYPASSRLS`, the table `FORCE ROW LEVEL SECURITY`, and the policy
must read the **same** setting `tenantScoped` was given —
`current_setting('app.tenant_id', true)` for the default — with the two-argument
form, or an unpinned connection errors instead of matching nothing. A policy
reading a name the extension never sets denies every row and every write, which
looks exactly like row security working. A superuser
connection bypasses every policy regardless, which makes a suite that runs as one
a false green.

**What an unpinned connection gets** is not one behaviour but two: `USING` hides
every row, so a read matches nothing, while `WITH CHECK` requires TRUE, so an
insert or an update is **rejected** with `42501` rather than quietly writing
nothing. A pinned statement naming another tenant is rejected the same way.
