import { readFile } from "node:fs/promises";

import { Env } from "@btravstack/config";
import { Observers, type Operation, type Settle, type Settled } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { prismaDatabase } from "@btravstack/prisma";
import postgres from "@prisma/orm-postgres/runtime";
import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import type { Contract } from "./prisma/contract.js";
import contractJson from "./prisma/contract.json" with { type: "json" };

describe("the oldest Prisma train @btravstack/prisma supports", () => {
  it("verifies a database migrated by the history released under it, unedited", async ({
    floor,
  }) => {
    // GIVEN the released history, applied by the floor CLI's `db migrate`
    const released = JSON.parse(
      await readFile(new URL("../prisma/migrations/app/refs/db.json", import.meta.url), "utf8"),
    ) as { readonly hash: string };

    // WHEN the deployment's check runs
    const verified = await floor.prisma("db", "verify");

    // THEN the marker is still the released one, and the schema matches it
    expect(verified).toEqual(
      expect.objectContaining({
        ok: true,
        marker: expect.objectContaining({ storageHash: released.hash }),
      }),
    );
  });

  it("boots over the floor client and observes every statement", async ({ floor }) => {
    // GIVEN the starter over an rc.11 client, as a role row security applies to
    const operations: (Operation & Settled)[] = [];
    const record =
      (operation: Operation): Settle =>
      (settled) => {
        operations.push({ ...operation, ...settled });
      };
    const database = prismaDatabase("FloorDatabase")({
      client: ({ url, middleware }) => postgres<Contract>({ contractJson, url, middleware }),
    });
    const root = Module("Root")({
      imports: [database],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: floor.url } }),
        Provider.member(Observers)({ inject: {}, value: record }),
      ],
      exports: [database.port],
    });

    // WHEN a unit reads through the ORM
    const found = await Module.scoped(root, (ctx) =>
      fromSafePromise(
        ctx.get(database.port).orm.orders.Customer.where({ tenantId: "floor" }).first(),
      ),
    );

    // THEN the boot's two checks and the read were each observed as a query
    // that opened before the driver ran and settled after it
    expect({ found, operations }).toEqual({
      found: expect.toBeOkWith(null),
      operations: [
        expect.objectContaining({ component: "database", name: "query", outcome: "ok" }),
        expect.objectContaining({ component: "database", name: "query", outcome: "ok" }),
        expect.objectContaining({
          component: "database",
          name: "query",
          outcome: "ok",
          details: { sql: expect.stringContaining("customer") },
        }),
      ],
    });
  });
});
