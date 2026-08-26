---
"@btravstack/amqp-worker": minor
"@btravstack/cache": minor
"@btravstack/config": minor
"@btravstack/contract": minor
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/http-server": minor
"@btravstack/mailer": minor
"@btravstack/observability": minor
"@btravstack/prisma": minor
"@btravstack/storage": minor
"@btravstack/temporal-worker": minor
"@btravstack/testing": minor
---

Raise the published Node floor to `>=22`, and use `Promise.withResolvers`.

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
