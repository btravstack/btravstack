// Prisma 7 config. The schema exists only so this layer has a concrete
// generated client to run its adapter against an in-memory SQLite database.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
});
