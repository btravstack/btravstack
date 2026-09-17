import { tryQuery } from "@btravstack/prisma/result";
import { tenantPinned } from "@btravstack/prisma/rls";
import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the tenant_isolation policy on Order", () => {
  it("matches no row for a connection nothing pinned", async ({
    raw,
    tenant,
    repository,
    anOrder,
  }) => {
    // GIVEN an order this tenant's repository committed
    // WHEN the same role asks for it with nothing pinned, naming the tenant
    const rows = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000601", 3))
      .flatMap(() =>
        fromSafePromise(raw.orm.public.Order.where({ tenantId: tenant }).all().toArray()),
      );

    // THEN it sees nothing: `current_setting('app.tenant_id', true)` is NULL,
    // so the policy's comparison is NULL, which is not true
    expect(rows).toBeOkWith([]);
  });

  it("shows a pinned transaction its own tenant's rows only", async ({
    raw,
    tenant,
    repository,
    otherRepository,
    anOrder,
  }) => {
    // GIVEN one order under this tenant and one under another
    // WHEN this tenant reads with NO filter at all
    const rows = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000602", 3))
      .flatMap(() => otherRepository.save(anOrder("0199a1e0-0000-7000-8000-000000000603", 4)))
      .flatMap(() => tenantPinned(raw, tenant, (tx) => tx.orm.public.Order.all().toArray()));

    // THEN the unfiltered query is already scoped — the database is what
    // narrowed it, not the query
    expect(rows).toBeOkWith([
      expect.objectContaining({
        tenantId: tenant,
        orderId: "0199a1e0-0000-7000-8000-000000000602",
      }),
    ]);
  });

  it("refuses an insert naming another tenant", async ({ raw, tenant, otherTenant }) => {
    // GIVEN a transaction pinned to this tenant
    // WHEN it writes a row claiming another one
    const refused = await tenantPinned(raw, tenant, (tx) =>
      tx.orm.public.Order.create({
        tenantId: otherTenant,
        orderId: "0199a1e0-0000-7000-8000-000000000604",
        quantity: 1,
      }),
    );

    // THEN `WITH CHECK` refuses it, as SQLSTATE 42501 — `NotAuthorized`, which
    // the orders adapter routes to its defect channel because an adapter bound
    // to one tenant cannot legitimately produce it
    expect(refused).toBeErrTagged("NotAuthorized");
  });

  it("refuses a write from a connection nothing pinned", async ({ raw, tenant }) => {
    // GIVEN the unpinned client, naming its own tenant on the row
    // WHEN it writes
    const refused = await tryQuery(() =>
      raw.orm.public.Order.create({
        tenantId: tenant,
        orderId: "0199a1e0-0000-7000-8000-000000000605",
        quantity: 1,
      }),
    );

    // THEN `WITH CHECK` is NULL with nothing pinned, and NULL is not true: the
    // write is refused rather than silently inserting nothing
    expect(refused).toBeErrTagged("NotAuthorized");
  });

  it("commits a pinned transaction across a policed and an unpoliced table", async ({
    raw,
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN nothing yet written for this tenant
    // WHEN `save` runs its one pinned transaction — the order row under the
    // policy, the outbox row beside it
    const written = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000606", 3))
      .flatMap(() => tenantPinned(raw, tenant, (tx) => tx.orm.public.Order.all().toArray()))
      .flatMap((orders) => outbox.pending(tenant, 10).map((events) => ({ orders, events })));

    // THEN both halves are there: the pin reached the whole transaction, and
    // the mixed write still committed as one
    expect(written).toBeOkWith({
      orders: [expect.objectContaining({ orderId: "0199a1e0-0000-7000-8000-000000000606" })],
      events: [
        expect.objectContaining({
          kind: "order",
          subjectId: "0199a1e0-0000-7000-8000-000000000606",
          payload: { quantity: 3 },
        }),
      ],
    });
  });
});

describe("the role the application connects as", () => {
  it("is neither a superuser nor exempt from row security", async ({ raw }) => {
    // GIVEN the connection every spec above made its assertions over
    // WHEN PostgreSQL is asked what that role is
    const roles = await raw
      .runtime()
      .query(
        raw.raw.sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          .returnsRow({ rolsuper: "pg/bool@1", rolbypassrls: "pg/bool@1" })
          .build(),
      );

    // THEN both are false. A superuser bypasses row security whatever a policy
    // says, so connecting as one would make every proof above vacuous — and
    // Prisma 8 emits `ENABLE ROW LEVEL SECURITY` without `FORCE`, so the table
    // OWNER would bypass it too. Connecting as a non-owner is what closes that.
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});
