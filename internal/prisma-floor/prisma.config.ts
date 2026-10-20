// The floor train's config, as an application on it writes one. `db` is the
// migration connection, set by the spec to a database of its own.

import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "./src/prisma/contract.prisma",
    db: { connection: process.env["DATABASE_URL"] ?? "" },
    migrations: { dir: "prisma/migrations" },
  }),
});
