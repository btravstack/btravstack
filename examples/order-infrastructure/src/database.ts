import { type PrismaBinding, prismaDatabase } from "@btravstack/prisma";
import postgres from "@prisma/orm-postgres/runtime";
import { OkAsync, type AsyncResult } from "unthrown";

import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };

/**
 * The one thing `@btravstack/prisma` cannot own: the client is typed by THIS
 * application's emitted `Contract` and constructed from its own
 * `contract.json`, so its type lives here. The starter's own middleware arrives
 * on the binding and is spread in beside anything the application adds — which
 * is where the per-query observation comes from, with no `$extends` and nothing
 * layered over a built client.
 */
const createClient = ({ url, middleware }: PrismaBinding) =>
  postgres<Contract>({ contractJson, url, middleware: middleware as never });

/** The client, typed by the contract: `db.orm.public.Order`, `db.sql`, `db.raw`. */
export type OrderDatabaseClient = ReturnType<typeof createClient>;

/** The transaction context a pinned unit of work runs on. */
export type OrderTransaction = Parameters<Parameters<OrderDatabaseClient["transaction"]>[0]>[0];

/**
 * The database, as a module. `@btravstack/prisma` owns `DATABASE_URL` through
 * `Config`, the pool's lifetime and the per-query observation; what stays here
 * is the client its `client` arrow builds.
 *
 * A deployment runs `prisma db migrate` against this same URL **before the
 * process starts**; the application never migrates itself at boot. The suites
 * do the same, once per run, so a test exercises the statements a deployment
 * runs rather than a copy that can drift.
 *
 * `OrderPersistenceModule` re-exports it, so a unit forked over the
 * application scope can read the client — which is what the orders repository
 * pins to its tenant, one transaction at a time.
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
  OkAsync(createClient({ url, middleware: [] }));
