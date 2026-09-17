import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

/**
 * Every `model` the contract declares. PostgreSQL gets a table named after the
 * model, lower-camel, unless `@@map` says otherwise — and nothing here uses
 * `@@map`.
 */
const modelsInContract = (): readonly string[] =>
  [
    ...readFileSync(
      fileURLToPath(new URL("./prisma/contract.prisma", import.meta.url)),
      "utf8",
    ).matchAll(/^model\s+(\w+)\s*\{/gm),
  ].map((match) => (match[1] ?? "").replace(/^./u, (first) => first.toLowerCase()));

describe("the committed migrations", () => {
  it("reads the models out of the contract it is checking against", () => {
    // GIVEN the contract source on disk
    // WHEN its models are parsed
    // THEN there are some — a regex that silently matched nothing would make
    // the table assertion below vacuously true
    expect(modelsInContract()).toEqual(
      expect.arrayContaining(["order", "customer", "outboxMessage"]),
    );
  });

  it("creates a table for every model the contract declares", async ({ db }) => {
    // GIVEN the models `contract.prisma` declares — the source `contract.d.ts`
    // is emitted from, and so the source the client's types come from
    const models = modelsInContract();

    // WHEN the database `openDatabase` built is asked what it actually has
    const tables = await db
      .runtime()
      .query(
        db.raw.sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`
          .returnsRow({ name: "pg/text@1" })
          .build(),
      );

    // THEN every model has its table. The migrations are planned from this
    // contract, so the two agree by construction — what this pins is that they
    // were *replanned*: editing the contract without running
    // `prisma migration plan` leaves the emitted types describing a column no
    // migration ever created, and nothing else in the gate would notice until a
    // query reached it.
    expect((tables as readonly { readonly name: string }[]).map((table) => table.name)).toEqual(
      expect.arrayContaining([...models]),
    );
  });

  it("keeps row security enabled and policed on Order", async ({ db }) => {
    // GIVEN the same database, carrying the policy the CONTRACT declares —
    // `@@rls` plus a `policy_all` block, planned and applied like any other
    // operation rather than hand-written DDL

    // WHEN it is asked what row security `order` carries
    const security = await db.runtime().query(
      db.raw
        .sql`SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, p.policyname AS policy
         FROM pg_class c
         LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'order'`
        .returnsRow({ enabled: "pg/bool@1", forced: "pg/bool@1", policy: "pg/text@1" })
        .build(),
    );

    // THEN row security is on and the policy is there, under the wire name the
    // planner hashed from the block's contents.
    //
    // `forced` is FALSE, and that is Prisma 8's own gap rather than a mistake
    // here: it emits `ENABLE ROW LEVEL SECURITY` and has no way to express
    // `FORCE`, so the table's OWNER still bypasses every policy. What closes it
    // is connecting as a non-owner — which is what `orders_app` is, and what
    // the role spec in `rls.spec.ts` pins. A deployment that connects as the
    // owner has no row security at all.
    expect(security).toEqual([
      { enabled: true, forced: false, policy: "order_tenant_isolation_c516f4ff" },
    ]);
  });
});
