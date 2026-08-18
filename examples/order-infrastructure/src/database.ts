import { Config } from "@btravstack/config";
import { currentUnit } from "@btravstack/core";
import { Port, Provider } from "@btravstack/di";
import { PrismaPg } from "@prisma/adapter-pg";
import { unthrownPrisma } from "@unthrown/prisma";
import { OkAsync, fromSafeThrowable, type AsyncResult, type Result } from "unthrown";

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
 * Whose data this call is about, read off the kernel's ambient unit record.
 *
 * This is the one reader the ambient store sanctions — an infrastructure
 * adapter stamping a tenant on a query, which is data about the unit and not
 * a collaborator anything could substitute (root `CLAUDE.md`, thesis 2). It is
 * read **per call**, never captured at construction: one client is built per
 * application scope and every unit has its own record. It is also the whole of
 * the tenancy story above this file — no port, use case or entity mentions a
 * tenant, because none of them has a decision to make about one.
 *
 * A call outside a unit has no tenant, and there is no sensible default —
 * "every tenant" would be a cross-tenant read and "the first one" is nonsense —
 * so it is a `Defect`, which is what the empty error channel says. Nothing a
 * caller did produced it and nothing they can do recovers from it; widening
 * every repository's `E` with an error no use case can act on would be worse.
 * `fromSafeThrowable` is how the defect is minted — `Defect` has no public
 * constructor, so a throw inside a boundary is the only route to one.
 */
const readTenant = fromSafeThrowable((): string => {
  const tenantId = currentUnit()?.tenantId;
  if (tenantId === undefined)
    // oxlint-disable-next-line unthrown/no-throw -- the throw IS the defect channel, and it is caught by the `fromSafeThrowable` boundary one line above
    throw new Error(
      "No tenant on the ambient unit record: every repository call must run inside a unit whose runtime supplied `UnitMeta.tenantId`.",
    );
  return tenantId;
});

export const currentTenant = (): Result<string, never> => readTenant();

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
