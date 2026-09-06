import { Port } from "@btravstack/di";
import { type TenantId } from "@btravstack/example-order-domain";
import { prismaDatabase } from "@btravstack/prisma";
import { tenantScoped } from "@btravstack/prisma/rls";
import { PrismaPg } from "@prisma/adapter-pg";
import { unthrownPrisma } from "@unthrown/prisma";
import { OkAsync, type AsyncResult } from "unthrown";

import { PrismaClient } from "./generated/prisma/client.ts";

/**
 * The one thing `@btravstack/prisma` cannot own: the client is generated from
 * THIS application's schema, so its type lives here. `@unthrown/prisma`'s
 * extension is applied here too, so what the graph holds is the extended client
 * — every model operation with a `try*` twin returning an `AsyncResult`.
 */
const createClient = (adapter: PrismaPg) => new PrismaClient({ adapter }).$extends(unthrownPrisma);

/** The extended client: every model operation has a `try*` twin returning an `AsyncResult`. */
export type OrderDatabaseClient = ReturnType<typeof createClient>;

/**
 * The database, as a module. `@btravstack/prisma` owns `DATABASE_URL` through
 * `Config`, the pool's lifetime and the per-query span, count and log line;
 * what stays here is the client its `client` arrow builds.
 *
 * A deployment runs `prisma migrate deploy` against this same URL **before the
 * process starts**; the application never migrates itself at boot. The suites do
 * the same, once per run, so a test exercises the statements a deployment runs
 * rather than a copy that can drift.
 *
 * `OrderPersistenceModule` re-exports it, so a unit forked over the
 * application scope can read the client — which is what
 * `OrderTenantPersistence` binds a tenant to. Nothing else in an application
 * has reason to, and nothing else does.
 */
export const OrderDatabaseModule = prismaDatabase("OrderDatabase")({ client: createClient });

/** The port the two persistence modules depend on, minted by the starter from the name above. */
export const OrderDatabase = OrderDatabaseModule.port;

/**
 * A client outside any scope, for the suites' fixtures. The starter deliberately
 * does not offer this: its whole subject is the pool's lifetime, and a fixture
 * that opens one by hand is asking for the opposite.
 */
export const openDatabase = (url: string): AsyncResult<OrderDatabaseClient, never> =>
  OkAsync(createClient(new PrismaPg({ connectionString: url })));

/**
 * The one client bound to one tenant. `tenantScoped` goes on LAST, so
 * `$tryTransaction` and the `try*` twins survive inside the transaction it
 * pins.
 */
export const scopedTo = (db: OrderDatabaseClient, tenant: TenantId) =>
  db.$extends(tenantScoped(tenant));

/** What every statement the orders repository issues runs through. */
export type TenantDatabase = ReturnType<typeof scopedTo>;

/**
 * The pinned client, as a port. It exists only inside a unit — the tenant it
 * closes over is that unit's — which is why it is `OrderTenantPersistence`
 * that provides it and not `OrderDatabaseModule`.
 */
export class Db extends Port("Db")<TenantDatabase> {}
