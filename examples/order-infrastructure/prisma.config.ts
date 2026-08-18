// Prisma 7 config.
//
// The `datasource` here is the **migration** connection, and it is the CLI's
// alone: `prisma migrate` needs a real database to diff against and apply to,
// while the application itself never uses this URL — it passes a driver
// adapter (`PrismaPg`) to `PrismaClient` instead. Prisma 7 removed `url` from
// the schema for exactly this reason: the schema describes the shape, the
// config says where the CLI should reach.
//
// `DATABASE_URL` is what a deployment sets before running `pnpm db:migrate`,
// and it is what `src/global-setup.ts` sets to the shared test server before
// running the very same command. There is no fallback: a migration aimed at
// an unnamed database is a mistake worth failing on rather than a scratch
// file to silently fill.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] ?? "" },
});
