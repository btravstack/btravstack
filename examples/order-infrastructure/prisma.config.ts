// Prisma 7 config.
//
// The `datasource` here is the **migration** connection, and it is the CLI's
// alone: `prisma migrate` needs a real database to diff against and apply to,
// while the application itself never uses this URL — it passes a driver
// adapter (`PrismaBetterSqlite3`) to `PrismaClient` instead. Prisma 7 removed
// `url` from the schema for exactly this reason: the schema describes the
// shape, the config says where the CLI should reach.
//
// `DATABASE_URL` is what a deployment sets before running `pnpm db:migrate`.
// The fallback is a gitignored scratch file so `db:migrate` works out of the
// box in a checkout, which is what generating the committed migrations needs.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] ?? "file:./.migrate.db" },
});
