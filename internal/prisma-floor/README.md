# @btravstack/internal-prisma-floor

The oldest Prisma 8 train `@btravstack/prisma` supports, held the way an
application on it holds it. Private, published nowhere, and its whole surface
is one spec on the Tests job.

The workspace resolves the `prisma-floor` catalog (`@prisma/orm-postgres`
8.0.0-rc.11, `prisma` 8.0.0-rc.15, `@prisma/cli-engine` 0.4.0) where the rest
of the gate resolves the newest train. `prisma/migrations` is the order
example's history as released under rc.11, byte for byte. It is the fixture
and is never edited or re-signed.

`src/prisma-floor.spec.ts` migrates a database of its own with that train's
`prisma db migrate`, then proves two things:

- `prisma db verify` passes with the released marker, so nothing the newer
  train needs reached the floor's history;
- `prismaDatabase` boots over a real rc.11 client, as a role row security
  applies to, and each of its statements reaches `Observers`, which is what
  0.44.0 lost on rc.11.

It also typechecks `postgres<Contract>({ middleware })` with no cast, so the
starter's middleware type is assignable to the floor's.

Raise the floor only in a major of `@btravstack/prisma`, with a migration
guide; see `packages/prisma/AGENTS.md`, _Two Prisma trains_.
