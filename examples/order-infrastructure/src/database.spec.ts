import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { prismaDatabase, type PrismaBinding } from "@btravstack/prisma";
import postgres from "@prisma/orm-postgres/runtime";
import { fromSafePromise } from "unthrown";
import { describe, expect, inject } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import type { Contract } from "./prisma/contract.js";
import contractJson from "./prisma/contract.json" with { type: "json" };

/**
 * This application's client, with a short connection timeout so a pool that
 * cannot hand out a connection fails in seconds rather than in Prisma's twenty.
 * The pool keeps Prisma's default of ten connections.
 */
const impatient = ({ url, middleware }: PrismaBinding) =>
  postgres<Contract>({
    contractJson,
    url,
    middleware: middleware as never,
    poolOptions: { connectionTimeoutMillis: 2_000 },
  });

const BurstDatabase = prismaDatabase("BurstDatabase")({ client: impatient });

const burstRoot = Module("BurstRoot")({
  imports: [BurstDatabase],
  provides: [
    Provider(Env)({ inject: {}, value: { DATABASE_URL: inject("__ORDERS_DATABASE_URL__") } }),
  ],
  exports: [BurstDatabase.port],
});

describe("the database a scope opens", () => {
  it("serves a burst of transactions larger than its pool, from its first statement", async () => {
    // GIVEN a freshly opened scope, and more concurrent transactions than the pool has connections
    const burst = 25;

    // WHEN every transaction runs its first statement at once
    const committed = await Module.scoped(burstRoot, (ctx) => {
      const db = ctx.get(BurstDatabase.port);
      return fromSafePromise(
        Promise.allSettled(
          Array.from({ length: burst }, () =>
            db.transaction((tx) => tx.query(db.raw.sql`SELECT 1`.affectedCount().build())),
          ),
        ).then((settled) => settled.filter(({ status }) => status === "fulfilled").length),
      );
    });

    // THEN all of them committed: the contract marker was verified before any of them took a connection
    expect(committed).toBeOkWith(burst);
  });
});
