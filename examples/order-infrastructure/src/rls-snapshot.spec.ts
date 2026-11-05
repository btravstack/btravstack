import { tenantPinned, type TenantPinnedOptions } from "@btravstack/prisma/rls";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("organization-pinned transaction snapshots", () => {
  it.for([
    { options: undefined, after: [4], isolation: "read committed", readOnly: "off" },
    {
      options: { isolationLevel: "repeatable read", readOnly: true },
      after: [3],
      isolation: "repeatable read",
      readOnly: "on",
    },
    {
      options: { isolationLevel: "serializable", readOnly: true },
      after: [3],
      isolation: "serializable",
      readOnly: "on",
    },
  ] satisfies readonly {
    options: TenantPinnedOptions | undefined;
    after: readonly number[];
    isolation: string;
    readOnly: string;
  }[])(
    "keeps the selected $isolation consistency boundary",
    async (scenario, { snapshotDb: raw, tenant, repository, otherRepository, anOrder }) => {
      // GIVEN
      (await repository.save(anOrder("0199a1e0-0000-7000-8000-000000000701", 3))).getOrThrow();
      (await otherRepository.save(anOrder("0199a1e0-0000-7000-8000-000000000702", 9))).getOrThrow();

      // WHEN
      const snapshot = await tenantPinned(
        raw,
        tenant,
        async (tx) => {
          const before = await tx.orm.orders.Order.all().toArray();
          (
            await tenantPinned(raw, tenant, (writer) =>
              writer.query(
                raw.raw.sql`UPDATE orders."order" SET quantity = 4 WHERE "tenantId" = ${tenant}`
                  .affectedCount()
                  .build(),
              ),
            )
          ).getOrThrow();
          const after = await tx.orm.orders.Order.all().toArray();
          const modes = await tx.query(
            raw.raw
              .sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`
              .returnsRow({ isolation: "pg/text@1", readOnly: "pg/text@1" })
              .build(),
          );
          return {
            before: before.map((row) => row.quantity),
            after: after.map((row) => row.quantity),
            modes,
          };
        },
        scenario.options,
      );

      // THEN
      expect(snapshot).toBeOkWith({
        before: [3],
        after: scenario.after,
        modes: [{ isolation: scenario.isolation, readOnly: scenario.readOnly }],
      });
    },
  );

  it("refuses writes in a read-only snapshot and leaves the row unchanged", async ({
    snapshotDb: raw,
    tenant,
    repository,
    anOrder,
  }) => {
    // GIVEN
    (await repository.save(anOrder("0199a1e0-0000-7000-8000-000000000703", 3))).getOrThrow();

    // WHEN
    const written = await tenantPinned(
      raw,
      tenant,
      (tx) =>
        tx.query(
          raw.raw.sql`UPDATE orders."order" SET quantity = 4 WHERE "tenantId" = ${tenant}`
            .affectedCount()
            .build(),
        ),
      { isolationLevel: "repeatable read", readOnly: true },
    );
    const rows = await tenantPinned(raw, tenant, (tx) => tx.orm.orders.Order.all().toArray());

    // THEN
    expect({ written, rows }).toEqual({
      written: expect.objectContaining({
        tag: "Defect",
        cause: expect.objectContaining({ sqlState: "25006" }),
      }),
      rows: expect.toBeOkWith([expect.objectContaining({ quantity: 3 })]),
    });
  });

  it.for([
    { failure: "modeled", tag: "Err" },
    { failure: "defect", tag: "Defect" },
  ])(
    "rolls back earlier writes after a $failure failure",
    async ({ failure, tag }, { snapshotDb: raw, tenant }) => {
      // GIVEN
      const order = {
        tenantId: tenant,
        orderId: "0199a1e0-0000-7000-8000-000000000704",
        quantity: 3,
      };

      // WHEN
      const written = await tenantPinned(
        raw,
        tenant,
        async (tx) => {
          await tx.orm.orders.Order.create(order);
          return failure === "modeled"
            ? tx.orm.orders.Order.create(order)
            : tx.query(raw.raw.sql`SELECT 1 / 0 AS invalid`.affectedCount().build());
        },
        { isolationLevel: "repeatable read", readOnly: false },
      );
      const rows = await tenantPinned(raw, tenant, (tx) => tx.orm.orders.Order.all().toArray());

      // THEN
      expect({ written, rows }).toEqual({
        written: expect.objectContaining({ tag }),
        rows: expect.toBeOkWith([]),
      });
    },
  );
});
