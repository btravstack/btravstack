import { tryQuery } from "@btravstack/prisma/result";
import { tenantPinned } from "@btravstack/prisma/rls";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("tenant listing under forced row security", () => {
  it("works when forced RLS applies to the table owner itself", async ({ listing }) => {
    // GIVEN the function owner becoming the owner of a table still under FORCE
    const { admin, declaration, app, schema, owner } = listing;
    const sql = `ALTER TABLE "${schema}".records OWNER TO "${owner}"`;

    // WHEN its security-definer function reads the table
    const result = await tryQuery(() =>
      admin.runtime().execute(
        admin.raw
          .sql(Object.assign([sql], { raw: [sql] }))
          .affectedCount()
          .build(),
      ),
    ).flatMap(() => declaration.list(app));

    // THEN its explicit owner policy supplies the listing despite forced RLS
    expect(result).toBeOkWith(["acme", "other"]);
  });

  it("ignores a caller's temporary table and hostile search path", async ({ listing }) => {
    // GIVEN a caller able to create a temporary table with the same name
    const { app, declaration } = listing;
    const commands = [
      "CREATE TEMP TABLE records (organization text, secret text)",
      "INSERT INTO records VALUES ('attacker', 'fake')",
      "SET LOCAL search_path = pg_temp, public",
    ];

    // WHEN the listing executes on that same connection
    const result = await tryQuery(() =>
      app.transaction(async (tx) => {
        for (const command of commands)
          await tx.execute(
            app.raw
              .sql(Object.assign([command], { raw: [command] }))
              .affectedCount()
              .build(),
          );
        return (
          await declaration.list({
            raw: app.raw,
            runtime: () => ({ query: (plan: never) => tx.query(plan) }),
          })
        ).getOrThrow();
      }),
    );

    // THEN it still reads the fully qualified protected table
    expect(result).toBeOkWith(["acme", "other"]);
  });

  it("rejects a listing whose execution grant was widened to PUBLIC", async ({ listing }) => {
    // GIVEN a previously installed listing
    const { admin, declaration, schema } = listing;
    const grant = `GRANT EXECUTE ON FUNCTION "${schema}".tenant_ids() TO PUBLIC`;
    const check = declaration.migration.postcheck[0]!;

    // WHEN its public execution privilege is widened
    const result = await tryQuery(() =>
      admin.runtime().execute(
        admin.raw
          .sql(Object.assign([grant], { raw: [grant] }))
          .affectedCount()
          .build(),
      ),
    ).flatMap(() =>
      tryQuery(() =>
        admin.runtime().query(
          admin.raw
            .sql(Object.assign([check.sql], { raw: [check.sql] }))
            .returnsRow({ result: "pg/bool@1" })
            .build(),
        ),
      ),
    );

    // THEN Prisma cannot consider that privileged object safely installed
    expect(result).toBeOkWith([{ result: false }]);
  });

  it("refuses an applicable restrictive policy instead of silently missing tenants", async ({
    listing,
  }) => {
    // GIVEN a table with its own restrictive tenant predicate
    const { admin, declaration, schema } = listing;
    const sql = `CREATE POLICY restrictive_tenants ON "${schema}".records AS RESTRICTIVE FOR SELECT TO PUBLIC USING (organization = current_setting('app.tenant_id', true))`;
    const check = declaration.migration.postcheck[0]!;

    // WHEN the migration's security requirements are rechecked
    const result = await tryQuery(() =>
      admin.runtime().execute(
        admin.raw
          .sql(Object.assign([sql], { raw: [sql] }))
          .affectedCount()
          .build(),
      ),
    ).flatMap(() =>
      tryQuery(() =>
        admin.runtime().query(
          admin.raw
            .sql(Object.assign([check.sql], { raw: [check.sql] }))
            .returnsRow({ result: "pg/bool@1" })
            .build(),
        ),
      ),
    );

    // THEN an owner-only permissive policy cannot falsely promise a complete list
    expect(result).toBeOkWith([{ result: false }]);
  });

  it("lists distinct non-null IDs across tenants and discovers new data", async ({ listing }) => {
    // GIVEN a listing installed over a forced-RLS table
    const { declaration, app, schema } = listing;
    const statement = `INSERT INTO "${schema}".records VALUES ('new-tenant', 'new-private-data')`;

    // WHEN new data is written after installation and the application lists tenants
    const result = await tenantPinned(app, "new-tenant", (tx) =>
      tx.execute(
        app.raw
          .sql(Object.assign([statement], { raw: [statement] }))
          .affectedCount()
          .build(),
      ),
    ).flatMap(() => declaration.list(app));

    // THEN it sees IDs only, deduplicated, with no static tenant configuration
    expect(result).toBeOkWith(["acme", "new-tenant", "other"]);
  });

  it("leaves ordinary unpinned reads blind to application rows", async ({ listing }) => {
    // GIVEN the same role that can execute the listing
    const { app, schema } = listing;
    const sql = `SELECT organization, secret FROM "${schema}".records`;

    // WHEN it reads the table directly
    const result = await tryQuery(() =>
      app.runtime().query(
        app.raw
          .sql(Object.assign([sql], { raw: [sql] }))
          .returnsRow({ organization: "pg/text@1", secret: "pg/text@1" })
          .build(),
      ),
    );

    // THEN the helper has granted no cross-tenant row access
    expect(result).toBeOkWith([]);
  });

  it("leaves pinned reads scoped to one tenant", async ({ listing }) => {
    // GIVEN an application transaction pinned to one tenant
    const { app, schema } = listing;
    const sql = `SELECT organization, secret FROM "${schema}".records ORDER BY secret`;

    // WHEN it reads with no tenant predicate
    const result = await tenantPinned(app, "acme", (tx) =>
      tx.query(
        app.raw
          .sql(Object.assign([sql], { raw: [sql] }))
          .returnsRow({ organization: "pg/text@1", secret: "pg/text@1" })
          .build(),
      ),
    );

    // THEN only that tenant's payloads are visible
    expect(result).toBeOkWith([
      { organization: "acme", secret: "private-a" },
      { organization: "acme", secret: "private-b" },
    ]);
  });

  it("denies execution to a role receiving only PUBLIC privileges", async ({ listing }) => {
    // GIVEN an unrelated role with schema usage but no execution grant
    const { admin, schema, outsider } = listing;
    const role = `SET LOCAL ROLE "${outsider}"`;
    const call = `SELECT "tenantId" FROM "${schema}".tenant_ids()`;

    // WHEN that role tries the function
    const result = await tryQuery(() =>
      admin.transaction(async (tx) => {
        await tx.execute(
          admin.raw
            .sql(Object.assign([role], { raw: [role] }))
            .affectedCount()
            .build(),
        );
        return tx.query(
          admin.raw
            .sql(Object.assign([call], { raw: [call] }))
            .returnsRow({ tenantId: "pg/text@1" })
            .build(),
        );
      }),
    );

    // THEN public execution has been revoked
    expect(result).toBeErrTagged("NotAuthorized");
  });

  it("gives the function owner no access to payload columns", async ({ listing }) => {
    // GIVEN a dedicated function owner that does not own the table
    const { admin, schema, owner } = listing;
    const role = `SET LOCAL ROLE "${owner}"`;
    const read = `SELECT secret FROM "${schema}".records`;

    // WHEN it tries a wider projection than the listing needs
    const result = await tryQuery(() =>
      admin.transaction(async (tx) => {
        await tx.execute(
          admin.raw
            .sql(Object.assign([role], { raw: [role] }))
            .affectedCount()
            .build(),
        );
        return tx.query(
          admin.raw
            .sql(Object.assign([read], { raw: [read] }))
            .returnsRow({ secret: "pg/text@1" })
            .build(),
        );
      }),
    );

    // THEN even the function owner has only the granted tenant column
    expect(result).toBeErrTagged("NotAuthorized");
  });
});
