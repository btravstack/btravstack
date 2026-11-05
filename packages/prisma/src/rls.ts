import type { AsyncResult } from "unthrown";

import { tryQuery, type QualifyOptions, type Raised, type SqlError } from "./result.js";

export {
  tenantListing,
  TenantListingInvalid,
  type TenantListing,
  type TenantListingOptions,
} from "./tenant-listing.js";

/**
 * Options of {@link tenantPinned}: `raises`, as {@link tryQuery} takes it,
 * and the setting the pin writes.
 */
export type TenantPinnedOptions<S extends string = never> = QualifyOptions<S> & {
  /**
   * The PostgreSQL run-time setting the policy reads. Defaults to
   * `app.tenant_id`, matching `current_setting('app.tenant_id', true)`.
   */
  readonly setting?: string;
  /** Established before the tenant pin; omitted to retain the connection's default. */
  readonly isolationLevel?: "read committed" | "repeatable read" | "serializable";
  /** Transaction access mode; omitted to retain the connection's default. */
  readonly readOnly?: boolean;
};

/**
 * The little of a Prisma 8 client this needs: the raw lane to build the pin
 * with, and `transaction` to run it in. Structural, so the starter never has to
 * name a contract it cannot see.
 */
type Pinnable<Tx> = {
  /**
   * Required to EXIST and deliberately not described further. Spelling the
   * tag's signature out would refuse every real client: a parameter is
   * contravariant, and the genuine `raw.sql` takes the target's own
   * interpolation union and its own row-spec type — both narrower than
   * anything this package, which cannot see a contract, could name.
   */
  readonly raw: { readonly sql: unknown };
  readonly transaction: <R>(fn: (tx: Tx) => PromiseLike<R>) => Promise<R>;
};

/** The pin's own view of a client, reached by a cast for the reason above. */
type Raw = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly (string | boolean)[]
    ) => {
      readonly affectedCount: () => { readonly build: () => unknown };
      readonly returnsRow: (spec: Readonly<Record<string, string>>) => {
        readonly build: () => unknown;
      };
    };
  };
};

/** What the pin needs of a transaction context: somewhere to run a plan. */
type Queryable = { readonly query: (plan: never) => PromiseLike<unknown> };

/**
 * Runs `work` in a transaction whose connection is pinned to `tenant`, so a
 * row-level-security policy reading `current_setting('app.tenant_id', true)`
 * admits that tenant's rows and no others.
 *
 * The pin is `set_config(setting, tenant, true)` — **transaction-local**, which
 * is the whole reason this opens a transaction rather than issuing the pin and
 * handing back a client. A session-scoped pin followed by a separate query
 * works only while the pool happens to hand back the same connection, and fails
 * the first time it does not; it is the shape a middleware would take, and it
 * is why there is no middleware here.
 *
 * It answers an `AsyncResult`, qualified by {@link tryQuery} — with
 * `raises` as it takes it: the pin and the
 * work run on one connection and fail on one channel, so a caller never wraps
 * this in a second combinator. `work` still hands back a `PromiseLike`, because
 * that is what Prisma's own transaction callback is.
 * `isolationLevel` and `readOnly`, when supplied, are set before the pin's
 * first query. Unsupported values are defects, never silently downgraded.
 * Use the starter's boot-probed client. A standalone client must finish an
 * initialization query first, so Prisma's marker check cannot precede the
 * isolation statement inside this transaction.
 *
 * @remarks
 * The policy must read the **same** setting name. A `tenantPinned(db, tenant,
 * work, { setting })` whose policy names a different one denies every row and
 * every write, which looks exactly like row security working.
 *
 * @example
 * ```ts
 * const orders = await tenantPinned(db, tenant, (tx) => tx.orm.orders.Order.all());
 * ```
 */
export const tenantPinned = <Tx extends Queryable, R, const S extends string = never>(
  db: Pinnable<Tx>,
  tenant: string,
  work: (tx: Tx) => PromiseLike<R>,
  options?: TenantPinnedOptions<S>,
): AsyncResult<R, SqlError | Raised<S>> => {
  return tryQuery(async () => {
    const isolation = options?.isolationLevel;
    const readOnly = options?.readOnly;
    if (
      isolation !== undefined &&
      isolation !== "read committed" &&
      isolation !== "repeatable read" &&
      isolation !== "serializable"
    ) {
      return Promise.reject(new TypeError("Unsupported tenantPinned isolationLevel"));
    }
    if (readOnly !== undefined && typeof readOnly !== "boolean") {
      return Promise.reject(new TypeError("Unsupported tenantPinned readOnly"));
    }
    const modes: string[] = [];
    if (isolation !== undefined) modes.push(`ISOLATION LEVEL ${isolation.toUpperCase()}`);
    if (readOnly !== undefined) modes.push(readOnly ? "READ ONLY" : "READ WRITE");
    const raw = (db as unknown as Raw).raw;
    const statement = `SET TRANSACTION ${modes.join(", ")}`;
    // SQL keywords cannot be bind parameters; every token above is allow-listed.
    const characteristics =
      modes.length === 0
        ? undefined
        : raw
            .sql(Object.assign([statement], { raw: [statement] }))
            .affectedCount()
            .build();
    const setting = options?.setting ?? "app.tenant_id";
    const pin = raw.sql`SELECT set_config(${setting}, ${tenant}, ${true}) AS pinned`
      .returnsRow({ pinned: "pg/text@1" })
      .build();
    return db.transaction(async (tx) => {
      const connection = tx as unknown as {
        readonly query: (plan: unknown) => PromiseLike<unknown>;
      };
      if (characteristics !== undefined) await connection.query(characteristics);
      await connection.query(pin);
      return work(tx);
    });
  }, options);
};
