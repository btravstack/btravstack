import { Config } from "@btravstack/config";
import { Port, Provider } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";
import { unthrownPrisma } from "@unthrown/prisma";
import { OkAsync, type AsyncResult } from "unthrown";

import { PrismaClient } from "./generated/prisma/client.ts";

/**
 * Where the database is, bound from the environment through the kernel's own
 * configuration rather than read off `process.env` by hand — the rule the
 * whole stack follows, and the reason nothing here calls `.parse()`.
 *
 * A deployment runs `pnpm db:migrate` (`prisma migrate deploy`) against this
 * same URL **before the process starts**, which is what the `db:migrate`
 * turbo task exists for; the application never migrates itself at boot. The
 * suites do exactly that too — `src/global-setup.ts` runs the same command
 * against the shared test server, once per run — so a test exercises the
 * statements a deployment runs rather than a hand-kept copy that can drift.
 */
export const databaseConfig = Config.provider("DatabaseConfig")(
  Config.object({ url: Config.string("DATABASE_URL") }),
);

const createClient = (url: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }).$extends(unthrownPrisma);

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
 * Opens a client against `url`. Connecting is lazy — the pool dials on the
 * first statement — so this cannot fail in the application's terms, which is
 * why the error channel is empty.
 */
export const openDatabase = (url: string): AsyncResult<OrderDatabaseClient, never> =>
  OkAsync(createClient(url));

/**
 * The resourceful arm: the pool is acquired when the scope opens and released
 * when it closes, so the kernel's teardown reaches a real resource.
 *
 * `$disconnect()` genuinely ends the driver adapter's pool — measured against
 * `pg_stat_activity`, the connection count drops — but the client is not dead
 * afterwards: Prisma reconnects lazily on the next statement, which is why no
 * spec asserts that a released client refuses to query. That was assertable
 * only while this example held SQLite **in memory**, where the database itself
 * died with the connection.
 */
export const orderDatabaseProvider = Provider(OrderDatabase)([databaseConfig.port], {
  acquire: (config) => openDatabase(config.url),
  release: (db) => db.$disconnect(),
});
