import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { scopedTo } from "./index.js";

describe("the tenant_isolation policy on Order", () => {
  it("matches no row for a connection nothing pinned", async ({
    raw,
    tenant,
    repository,
    anOrder,
  }) => {
    // GIVEN an order this tenant's pinned repository committed
    // WHEN the same role asks for it with nothing pinned, naming the tenant
    const rows = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000601", 3))
      .flatMap(() => fromSafePromise(raw.order.findMany({ where: { tenantId: tenant } })));

    // THEN it sees nothing: `current_setting('app.tenant_id', true)` is NULL,
    // so the policy's comparison is NULL, which is not true
    expect(rows).toBeOkWith([]);
  });

  it("shows a pinned connection its own tenant's rows only", async ({
    db,
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
      .flatMap(() => fromSafePromise(scopedTo(db, tenant).order.findMany()));

    // THEN the unfiltered query is already scoped — the database is what
    // narrowed it, not the query
    expect(rows).toBeOkWith([
      expect.objectContaining({
        tenantId: tenant,
        orderId: "0199a1e0-0000-7000-8000-000000000602",
      }),
    ]);
  });

  it("refuses an insert naming another tenant", async ({ db, tenant, otherTenant }) => {
    // GIVEN a client pinned to this tenant
    // WHEN it writes a row claiming another one
    const refused = await scopedTo(db, tenant).order.tryCreate({
      data: {
        tenantId: otherTenant,
        orderId: "0199a1e0-0000-7000-8000-000000000604",
        quantity: 1,
      },
    });

    // THEN `WITH CHECK` refuses it, as a DEFECT: `42501` is none of the three
    // P-codes `@unthrown/prisma` models, and a tenant a caller cannot name is
    // not an outcome the application branches on
    expect(refused).toBeDefectWith(
      expect.objectContaining({ message: expect.stringContaining("42501") }),
    );
  });

  it("commits a pinned transaction across a policed and an unpoliced table", async ({
    db,
    tenant,
    repository,
    outbox,
    anOrder,
  }) => {
    // GIVEN nothing yet written for this tenant
    // WHEN `save` runs its one `$tryTransaction` — the order row under the
    // policy, the outbox row beside it
    const written = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000605", 3))
      .flatMap(() => fromSafePromise(scopedTo(db, tenant).order.findMany()))
      .flatMap((orders) => outbox.pending(tenant, 10).map((events) => ({ orders, events })));

    // THEN both halves are there: the pin reached the whole transaction, and
    // the mixed write still committed as one
    expect(written).toBeOkWith({
      orders: [expect.objectContaining({ orderId: "0199a1e0-0000-7000-8000-000000000605" })],
      events: [
        expect.objectContaining({
          kind: "order",
          subjectId: "0199a1e0-0000-7000-8000-000000000605",
          payload: { quantity: 3 },
        }),
      ],
    });
  });

  it("keeps list answering one tenant with no tenant in the query", async ({
    repository,
    otherRepository,
    anOrder,
  }) => {
    // GIVEN one order under this tenant and one under another
    // WHEN this tenant lists, through the `where` that no longer names it
    const listed = await repository
      .save(anOrder("0199a1e0-0000-7000-8000-000000000606", 1))
      .flatMap(() => otherRepository.save(anOrder("0199a1e0-0000-7000-8000-000000000607", 1)))
      .flatMap(() => repository.list({ limit: 10 }));

    // THEN the page is this tenant's, held by the policy alone
    expect(listed).toBeOkWith({
      items: [expect.objectContaining({ id: "0199a1e0-0000-7000-8000-000000000606" })],
      hasPreviousPage: false,
      hasNextPage: false,
    });
  });
});

describe("the role the application connects as", () => {
  it("is neither a superuser nor exempt from row security", async ({ raw }) => {
    // GIVEN the connection every spec above made its assertions over
    // WHEN PostgreSQL is asked what that role is
    const roles = await raw.$queryRaw<
      readonly { readonly rolsuper: boolean; readonly rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

    // THEN both are false. A superuser bypasses row security whatever `FORCE`
    // says, so connecting as one would make every proof above vacuous
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});
