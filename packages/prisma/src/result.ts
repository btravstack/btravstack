import { TaggedError, fromPromise, type AsyncResult } from "unthrown";

/**
 * A write refused by a unique index or constraint — SQLSTATE `23505`.
 *
 * `constraint` is the index the database named, which is what makes this
 * translatable: a table with two unique constraints produces one error type and
 * the caller still knows which one fired.
 */
export class UniqueConstraintViolation extends TaggedError("UniqueConstraintViolation")<{
  readonly constraint: string | undefined;
  readonly table: string | undefined;
}> {}

/** A write refused by a foreign key — SQLSTATE `23503`. */
export class ForeignKeyViolation extends TaggedError("ForeignKeyViolation")<{
  readonly constraint: string | undefined;
  readonly table: string | undefined;
}> {}

/**
 * The database refused the statement outright — SQLSTATE `42501`.
 *
 * On a table with row-level security this is what a `WITH CHECK` violation
 * looks like — an `INSERT` or an `UPDATE` whose resulting row falls outside the
 * policy. It is **not** what every cross-tenant statement produces: `USING`
 * FILTERS, so a `SELECT`, `UPDATE` or `DELETE` that matches another tenant's
 * rows answers nothing at all rather than failing. Only a write that lands
 * outside the policy raises this.
 *
 * It is modeled rather than left as a defect because only the caller knows
 * whether reaching it is a bug (an adapter bound to one tenant) or a request
 * (a caller asking for something it may not have).
 */
export class NotAuthorized extends TaggedError("NotAuthorized")<{
  readonly table: string | undefined;
}> {}

/** What {@link qualify} models. Anything else is a defect. */
export type SqlError = UniqueConstraintViolation | ForeignKeyViolation | NotAuthorized;

/**
 * What a Prisma 8 `SqlQueryError` carries, as a structural type.
 *
 * Read structurally rather than imported so this module depends on `unthrown`
 * and nothing else — which is what lets it move to the `unthrown` repository as
 * a package of its own. The fields are Postgres's own: `sqlState` is the
 * five-character SQLSTATE, not a vendor error code.
 */
type SqlQueryErrorLike = {
  readonly sqlState?: string;
  readonly constraint?: string;
  readonly table?: string;
};

/**
 * SQLSTATE → a tagged error, or the caller's defect for anything unmodeled.
 *
 * The three arms are the ones an application triages. Everything else — a
 * syntax error, a dead connection, a deadlock — is infrastructure a caller
 * cannot act on differently, and belongs on the defect channel where an
 * unexpected failure already goes.
 */
export const qualify = <D>(cause: unknown, defect: (cause: unknown) => D): SqlError | D => {
  const error = cause as SqlQueryErrorLike | null;
  switch (error?.sqlState) {
    case "23505":
      return new UniqueConstraintViolation({
        constraint: error.constraint,
        table: error.table,
      });
    case "23503":
      return new ForeignKeyViolation({ constraint: error.constraint, table: error.table });
    case "42501":
      return new NotAuthorized({ table: error.table });
    default:
      return defect(cause);
  }
};

/**
 * Runs a query and answers a `Result` instead of rejecting.
 *
 * It takes a **thunk**, not a promise: an `AsyncResult` is eager, and a promise
 * built at the call site has already started before the Result exists. Passing
 * the work in unstarted is what keeps a sequence of these a sequence rather
 * than a race.
 *
 * @example
 * ```ts
 * const save = (order: Order) =>
 *   tryQuery(() => db.orm.public.Order.create({ orderId: order.id })).mapErrCases(
 *     (matcher, defect) =>
 *       matcher
 *         .with(P.tag("UniqueConstraintViolation"), () => new DuplicateOrder({ id: order.id }))
 *         .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
 *         .with(P.tag("NotAuthorized"), (refused) => defect(refused)),
 *   );
 * ```
 */
export const tryQuery = <T>(run: () => PromiseLike<T>): AsyncResult<T, SqlError> =>
  fromPromise(
    // `Promise.resolve().then(run)` rather than `run()`: a thunk that throws
    // SYNCHRONOUSLY would otherwise escape past `fromPromise` as a real throw,
    // which is exactly the channel this function exists to close.
    Promise.resolve().then(run),
    qualify,
  );
