import { Err, Ok, TaggedError, type AsyncResult, type Result } from "unthrown";

import { tryQuery, type SqlError } from "./result.js";

/** A tenant-listing declaration names an invalid identifier or shares its privileged owner with its caller. */
export class TenantListingInvalid extends TaggedError("TenantListingInvalid")<{
  readonly field: keyof TenantListingOptions;
  readonly reason: "invalid-identifier" | "shared-role";
}> {}

/** Physical database names and existing roles for a narrow tenant-listing capability. */
export type TenantListingOptions = {
  readonly schema: string;
  readonly table: string;
  /** The physical tenant column. Default `tenantId`. */
  readonly tenantColumn?: string;
  /** A new paged function in `schema`; also names its select policy. */
  readonly name: string;
  /** Trusted function owner with no payload SELECT, superuser or BYPASSRLS; needs schema CREATE. */
  readonly owner: string;
  /** Application role granted execution, with no membership in `owner` and no schema CREATE privilege. */
  readonly role: string;
};

type Statement = { readonly description: string; readonly sql: string };

/** A declaration's migration, ready for Prisma 8's `rawSql`, and its tenant-id-only query. */
export type TenantListing = {
  readonly migration: {
    readonly id: string;
    readonly label: string;
    readonly operationClass: "additive";
    readonly target: {
      readonly id: "postgres";
      readonly details: {
        readonly schema: string;
        readonly objectType: "rlsPolicy";
        readonly table: string;
        readonly name: string;
      };
    };
    readonly precheck: readonly Statement[];
    readonly execute: readonly Statement[];
    readonly postcheck: readonly Statement[];
  };
  /** At most 100 IDs in bytewise order. Resume with the last ID; stop on an empty page. */
  readonly list: (
    db: {
      readonly raw: { readonly sql: unknown };
      readonly runtime: unknown;
    },
    after?: string,
  ) => AsyncResult<readonly string[], SqlError>;
};

type ListingClient = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly string[]
    ) => {
      readonly returnsRow: (spec: { readonly tenantId: "pg/text@1" }) => {
        readonly build: () => unknown;
      };
    };
  };
  readonly runtime: () => {
    readonly query: (plan: unknown) => PromiseLike<readonly { readonly tenantId: string }[]>;
  };
};

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string): string =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const statement = (parts: string[]): TemplateStringsArray =>
  Object.assign(parts, { raw: [...parts] });

/**
 * Declare a paged SECURITY DEFINER function returning distinct, non-null
 * tenant IDs as text, and a typed query calling only that function. Each page
 * holds at most 100 IDs in bytewise order; resume after its last ID until empty.
 *
 * Pass `migration` to Prisma 8's `rawSql` inside a reviewed migration. Its
 * transaction installs an owner-only SELECT policy, grants the owner access
 * to the tenant column, fixes the function's search path, revokes PUBLIC
 * execution and grants execution to `role`. Existing table policies and FORCE
 * ROW LEVEL SECURITY are left intact. No application table privilege is added.
 *
 * Roles and the table must already exist. The migrator must be able to SET ROLE
 * to the owner; provision that membership for an ordinary migration role.
 * The migration refuses a privileged application or function-owner role, caller membership in the owner, schema
 * CREATE for the caller, owner payload SELECT, or any same-name function overload. Its postcheck verifies the
 * function, policy and execution grants before Prisma records it as applied.
 * Apply the operation transactionally; the function is initially private only
 * once the REVOKE runs. Do not grant the application the owner role afterwards.
 */
export const tenantListing = (
  options: TenantListingOptions,
): Result<TenantListing, TenantListingInvalid> => {
  const names = {
    schema: options.schema,
    table: options.table,
    tenantColumn: options.tenantColumn ?? "tenantId",
    name: options.name,
    owner: options.owner,
    role: options.role,
  };
  for (const [field, value] of Object.entries(names)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.from(value, "utf8").toString("utf8") !== value ||
      Buffer.byteLength(value, "utf8") > 63
    )
      return Err(
        new TenantListingInvalid({
          field: field as keyof TenantListingOptions,
          reason: "invalid-identifier",
        }),
      );
  }
  if (names.owner === names.role)
    return Err(new TenantListingInvalid({ field: "role", reason: "shared-role" }));

  const schema = identifier(names.schema);
  const table = `${schema}.${identifier(names.table)}`;
  const fn = `${schema}.${identifier(names.name)}`;
  const owner = identifier(names.owner);
  const role = identifier(names.role);
  const column = identifier(names.tenantColumn);
  const functionRef = `pg_catalog.to_regprocedure(${literal(`${fn}(pg_catalog.text)`)})`;
  const tableRef = `pg_catalog.to_regclass(${literal(table)})`;
  const ownerRef = `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${literal(names.owner)})`;
  const roleRef = `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${literal(names.role)})`;
  const body = `SELECT DISTINCT ${column}::pg_catalog.text COLLATE pg_catalog."C" AS "tenantId" FROM ${table} WHERE ${column} IS NOT NULL AND ($1 IS NULL OR ${column}::pg_catalog.text COLLATE pg_catalog."C" > $1 COLLATE pg_catalog."C") ORDER BY "tenantId" LIMIT 100`;
  const policy = `CURRENT_USER = ${literal(names.owner)}::pg_catalog.name`;
  const assumption =
    "CASE WHEN pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >= 160000 THEN 'SET' ELSE 'MEMBER' END";
  const requirements = `EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    JOIN pg_catalog.pg_roles o ON o.rolname = ${literal(names.owner)}
    JOIN pg_catalog.pg_roles r ON r.rolname = ${literal(names.role)}
    WHERE c.oid = ${tableRef} AND c.relrowsecurity AND a.attname = ${literal(names.tenantColumn)} AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT pg_catalog.pg_has_role(r.oid, o.oid, 'MEMBER')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute payload
        WHERE payload.attrelid = c.oid AND payload.attnum > 0 AND NOT payload.attisdropped
          AND payload.attname <> ${literal(names.tenantColumn)}
          AND pg_catalog.has_column_privilege(o.oid, c.oid, payload.attname, 'SELECT')
      )
      AND pg_catalog.has_schema_privilege(o.oid, ${literal(names.schema)}, 'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles creator
        WHERE pg_catalog.pg_has_role(r.oid, creator.oid, ${assumption})
          AND pg_catalog.has_schema_privilege(creator.oid, ${literal(names.schema)}, 'CREATE')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy blocked WHERE blocked.polrelid = c.oid
          AND NOT blocked.polpermissive AND blocked.polcmd IN ('r', '*')
          AND EXISTS (SELECT 1 FROM pg_catalog.unnest(blocked.polroles) inherited(role)
            WHERE CASE WHEN inherited.role = 0 THEN true ELSE pg_catalog.pg_has_role(o.oid, inherited.role, 'USAGE') END)
      )
  )`;
  const functions = `SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${literal(names.schema)} AND p.proname = ${literal(names.name)}`;
  const ready = `SELECT ${requirements} AND (SELECT count(*) FROM (${functions}) candidates) = 1 AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = ${functionRef}
      AND p.prosecdef AND NOT p.proisstrict AND p.proretset AND p.pronargs = 1 AND p.pronargdefaults = 1 AND pg_catalog.pg_get_expr(p.proargdefaults, 0) IN ('NULL::text', 'NULL::pg_catalog.text') AND p.provolatile = 's'
      AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'sql')
      AND p.proowner = ${ownerRef} AND p.prosrc = ${literal(body)}
      AND p.proallargtypes = ARRAY['pg_catalog.text'::pg_catalog.regtype, 'pg_catalog.text'::pg_catalog.regtype]::pg_catalog.oid[]
      AND p.proargnames = ARRAY['after', 'tenantId']::pg_catalog.text[] AND p.proargmodes = ARRAY['i', 't']::pg_catalog."char"[]
      AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp', 'row_security=on']::pg_catalog.text[]
      AND pg_catalog.has_function_privilege(${roleRef}, p.oid, 'EXECUTE')
      AND pg_catalog.has_schema_privilege(${roleRef}, ${literal(names.schema)}, 'USAGE')
      AND pg_catalog.has_schema_privilege(${ownerRef}, ${literal(names.schema)}, 'USAGE')
      AND pg_catalog.has_column_privilege(${ownerRef}, ${tableRef}, ${literal(names.tenantColumn)}, 'SELECT')
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        WHERE a.privilege_type = 'EXECUTE' AND (a.grantee NOT IN (${ownerRef}, ${roleRef}) OR (a.grantee = ${roleRef} AND a.is_grantable))
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = ${tableRef}
          AND pol.polname = ${literal(names.name)} AND pol.polcmd = 'r' AND pol.polpermissive
          AND pol.polroles = ARRAY[${ownerRef}]::pg_catalog.oid[]
          AND pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) = '(CURRENT_USER = ' || pg_catalog.quote_literal(${literal(names.owner)}) || '::name)'
      )
  ) AS "result"`;
  const parts = [`SELECT "tenantId" FROM ${fn}(`, `) ORDER BY "tenantId" COLLATE pg_catalog."C"`];

  return Ok({
    migration: {
      id: `tenantListing.${encodeURIComponent(names.schema).replaceAll(".", "%2E")}.${encodeURIComponent(names.name).replaceAll(".", "%2E")}`,
      label: `List tenant IDs from ${table}`,
      operationClass: "additive",
      target: {
        id: "postgres",
        details: {
          schema: names.schema,
          objectType: "rlsPolicy",
          table: names.table,
          name: names.name,
        },
      },
      precheck: [
        {
          description:
            "require a row-secured table, restricted roles, and unused function and policy names",
          sql: `SELECT ${requirements} AND pg_catalog.pg_has_role(CURRENT_USER, ${ownerRef}, ${assumption}) AND NOT EXISTS (${functions}) AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = ${tableRef} AND polname = ${literal(names.name)}
        ) AS "result"`,
        },
      ],
      execute: [
        {
          description: "allow the function owner to read tenant IDs under forced RLS",
          sql: `CREATE POLICY ${identifier(names.name)} ON ${table} FOR SELECT TO ${owner} USING (${policy})`,
        },
        {
          description: "grant schema access to the function owner and caller",
          sql: `GRANT USAGE ON SCHEMA ${schema} TO ${owner}, ${role}`,
        },
        {
          description: "grant the function owner the tenant column",
          sql: `GRANT SELECT (${column}) ON TABLE ${table} TO ${owner}`,
        },
        {
          description: "create the tenant-id-only function with a fixed search path",
          sql: `CREATE FUNCTION ${fn}("after" pg_catalog.text DEFAULT NULL) RETURNS TABLE ("tenantId" pg_catalog.text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = on AS ${literal(body)}`,
        },
        {
          description: "remove public execution",
          sql: `REVOKE ALL ON FUNCTION ${fn}(pg_catalog.text) FROM PUBLIC`,
        },
        {
          description: "grant execution to the application role",
          sql: `GRANT EXECUTE ON FUNCTION ${fn}(pg_catalog.text) TO ${role}`,
        },
        {
          description: "assign the restricted function owner",
          sql: `ALTER FUNCTION ${fn}(pg_catalog.text) OWNER TO ${owner}`,
        },
      ],
      postcheck: [
        {
          description: "verify the listing function, owner policy, and narrow execution grants",
          sql: ready,
        },
      ],
    },
    list: (db, after) =>
      tryQuery(() => {
        const client = db as ListingClient;
        const query =
          after === undefined
            ? client.raw.sql(statement([`${parts[0]}NULL${parts[1]}`]))
            : client.raw.sql(statement(parts), after);
        const plan = query.returnsRow({ tenantId: "pg/text@1" }).build();
        return client.runtime().query(plan);
      }).map((rows) => rows.map((row) => row.tenantId)),
  });
};
