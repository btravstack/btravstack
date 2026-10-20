import { readFile } from "node:fs/promises";

import { Env } from "@btravstack/config";
import { Observers, type Operation, type Settle } from "@btravstack/core";
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
    const operations: Operation[] = [];
    const record = (operation: Operation): Settle => {
      operations.push(operation);
      return () => undefined;
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

    // THEN the boot's two checks and the read each reached the observers as a query
    expect({ found, operations }).toEqual({
      found: expect.toBeOkWith(null),
      operations: [
        expect.objectContaining({ component: "database", name: "query" }),
        expect.objectContaining({ component: "database", name: "query" }),
        expect.objectContaining({
          component: "database",
          name: "query",
          details: { sql: expect.stringContaining("customer") },
        }),
      ],
    });
  });
});
