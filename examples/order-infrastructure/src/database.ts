import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Port, Provider } from "@btravstack/di";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { unthrownPrisma } from "@unthrown/prisma";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { PrismaClient } from "./generated/prisma/client.ts";

/**
 * The migrations, as `prisma migrate dev` generated them and as they are
 * committed — the single source of truth for this schema's shape.
 *
 * A deployment with a durable database runs `pnpm db:migrate`
 * (`prisma migrate deploy`) **before the process starts**, which is what the
 * `db:migrate` turbo task exists for; the application never migrates itself at
 * boot. This example's database cannot be reached that way — it is SQLite held
 * *in memory*, born empty inside `openDatabase` and gone when the process is,
 * so no external command can prepare it — so the same committed SQL is applied
 * here instead. That is the point: tests run the exact statements a deployment
 * runs, rather than a hand-kept copy that can drift from the schema.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));

const migrations = (): readonly string[] =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Prisma names migration directories with a leading timestamp, so
    // lexicographic order IS chronological order — the order they must be
    // applied in, and the order `migrate deploy` applies them in.
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readFileSync(`${MIGRATIONS_DIR}${entry.name}/migration.sql`, "utf8"));

/**
 * One migration file holds several statements; better-sqlite3's `exec` (which
 * `$executeRawUnsafe` reaches) takes one at a time, so the file is split on
 * `;` and the empty tail dropped. Comments survive fine — SQLite parses them.
 */
const statementsOf = (migration: string): readonly string[] =>
  migration
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const createClient = () =>
  new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: ":memory:" }) }).$extends(
    unthrownPrisma,
  );

/** The extended client: every model operation has a `try*` twin returning an `AsyncResult`. */
export type OrderDatabaseClient = ReturnType<typeof createClient>;

/**
 * Internal to this layer: `DatabaseModule` provides and exports it so the two
 * persistence modules can depend on it, and neither of those re-exports it —
 * so no outer module can reach the client and start speaking SQL. The only
 * things that cross the boundary are the repositories and the outbox.
 */
export class OrderDatabase extends Port("OrderDatabase")<OrderDatabaseClient> {}

/**
 * Opens a fresh in-memory database with every committed migration applied.
 *
 * `AsyncResult`, not a bare `Promise`: this is an exported async surface, and
 * the rule the rest of the stack follows is that every one of them returns a
 * `Result` rather than leaving a caller to mix `await` styles. Opening cannot
 * fail in the application's terms — a database that will not open is a defect,
 * not a domain outcome — so the error channel is empty and the boundary is
 * `fromSafePromise`.
 */
export const openDatabase = (): AsyncResult<OrderDatabaseClient, never> =>
  fromSafePromise(
    (async () => {
      const db = createClient();
      for (const migration of migrations()) {
        for (const statement of statementsOf(migration)) await db.$executeRawUnsafe(statement);
      }
      return db;
    })(),
  );

/**
 * The resourceful arm: the connection is acquired when the scope opens and
 * released when it closes, so the kernel's teardown reaches a real resource
 * rather than a bookkeeping entry.
 */
export const orderDatabaseProvider = Provider(OrderDatabase)({
  acquire: () => openDatabase(),
  release: (db) => db.$disconnect(),
});
