import type { AsyncResult } from "unthrown";

import { tryQuery, type SqlError } from "./result.js";

/** Options of {@link tenantPinned}. */
export type TenantPinnedOptions = {
  /**
   * The PostgreSQL run-time setting the policy reads. Defaults to
   * `app.tenant_id`, matching `current_setting('app.tenant_id', true)`.
   */
  readonly setting?: string;
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
 * It answers an `AsyncResult`, qualified by {@link tryQuery}: the pin and the
 * work run on one connection and fail on one channel, so a caller never wraps
 * this in a second combinator. `work` still hands back a `PromiseLike`, because
 * that is what Prisma's own transaction callback is.
 *
 * @remarks
 * The policy must read the **same** setting name. A `tenantPinned(db, tenant,
 * work, { setting })` whose policy names a different one denies every row and
 * every write, which looks exactly like row security working.
 *
 * @example
 * ```ts
 * const orders = await tenantPinned(db, tenant, (tx) => tx.orm.public.Order.all());
 * ```
 */
export const tenantPinned = <Tx extends Queryable, R>(
  db: Pinnable<Tx>,
  tenant: string,
  work: (tx: Tx) => PromiseLike<R>,
  options?: TenantPinnedOptions,
): AsyncResult<R, SqlError> => {
  const setting = options?.setting ?? "app.tenant_id";
  // Built off the client, run on the transaction: `db.raw` is where the tagged
  // template lives, and `tx.query` is what puts the statement on the
  // transaction's own connection. `pg/text@1` is the codec every Postgres
  // contract registers for a text column, which is what `set_config` answers.
  const plan = (db as unknown as Raw).raw
    .sql`SELECT set_config(${setting}, ${tenant}, ${true}) AS pinned`
    .returnsRow({
      pinned: "pg/text@1",
    })
    .build();
  return tryQuery(() =>
    db.transaction(async (tx) => {
      await (tx as unknown as { readonly query: (plan: unknown) => PromiseLike<unknown> }).query(
        plan,
      );
      return work(tx);
    }),
  );
};
