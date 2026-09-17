// Prisma 8 config.
//
// `db` here is the **migration** connection, and it is the CLI's alone:
// planning and applying a migration needs a real database to diff against,
// while the application itself reaches the same database through its own
// `DATABASE_URL` read by `@btravstack/prisma`. There is no fallback: a
// migration aimed at an unnamed database is a mistake worth failing on rather
// than a scratch file to silently fill.
//
// `DATABASE_URL` is what a deployment sets before running `pnpm db:migrate`,
// and it is what `src/global-setup.ts` sets to the shared test server before
// running the very same command.

import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "./src/prisma/contract.prisma",
    db: { connection: process.env["DATABASE_URL"] ?? "" },
    migrations: { dir: "prisma/migrations" },
  }),
});
