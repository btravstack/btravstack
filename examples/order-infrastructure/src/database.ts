import { Port, Provider } from "@btravstack/di";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { unthrownPrisma } from "@unthrown/prisma";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { PrismaClient } from "./generated/prisma/client.ts";

/**
 * The example's database is SQLite held in memory, so it is born empty and its
 * tables are created by hand — no migration engine, no file on disk, nothing to
 * clean up between runs.
 */
const DDL = [
  `CREATE TABLE "Order" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "orderId" TEXT NOT NULL, "quantity" INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX "Order_orderId_key" ON "Order"("orderId")`,
  `CREATE TABLE "OutboxMessage" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "orderId" TEXT NOT NULL, "quantity" INTEGER NOT NULL, "publishedAt" DATETIME)`,
];

const createClient = () =>
  new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: ":memory:" }) }).$extends(
    unthrownPrisma,
  );

/** The extended client: every model operation has a `try*` twin returning an `AsyncResult`. */
export type OrderDatabaseClient = ReturnType<typeof createClient>;

/**
 * Internal to this layer: `PersistenceModule` provides it but does not export
 * it, so no outer module can reach the client and start speaking SQL. The only
 * thing that crosses the boundary is `OrderRepository`.
 */
export class OrderDatabase extends Port("OrderDatabase")<OrderDatabaseClient> {}

/**
 * Opens a fresh in-memory database with the schema applied.
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
      for (const statement of DDL) await db.$executeRawUnsafe(statement);
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
