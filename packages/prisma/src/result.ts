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

/**
 * A SQLSTATE the application raises on purpose — a trigger or a function
 * refusing a write the schema cannot express with `RAISE EXCEPTION … USING
 * ERRCODE = '…'` — modeled because the caller listed it in `raises`.
 *
 * `message` is the one the `RAISE` wrote. Raise in a class of your own rather
 * than in `XX`, which PostgreSQL reserves for its internal errors.
 */
export class RaisedException<S extends string = string> extends TaggedError("RaisedException")<{
  readonly sqlState: S;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
}> {
  constructor({
    message,
    ...fields
  }: {
    readonly sqlState: S;
    readonly message: string;
    readonly constraint: string | undefined;
    readonly table: string | undefined;
  }) {
    super(fields);
    this.message = message;
  }
}

/** What {@link qualify} models. Anything else is a defect. */
export type SqlError = UniqueConstraintViolation | ForeignKeyViolation | NotAuthorized;

/**
 * One {@link RaisedException} per SQLSTATE listed, and nothing when none is,
 * so a caller that lists no code keeps the three arms it already matches.
 */
export type Raised<S extends string> = S extends string ? RaisedException<S> : never;

/** Options of {@link tryQuery} and {@link qualify}. */
export type QualifyOptions<S extends string> = {
  /**
   * The SQLSTATEs the application raises on purpose and wants as a
   * {@link RaisedException} rather than a defect. The three SQLSTATEs
   * {@link SqlError} already models keep their own arms.
   */
  readonly raises?: readonly S[];
};

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
  readonly message: string;
  readonly constraint?: string;
  readonly table?: string;
};

/**
 * SQLSTATE → a tagged error, or the caller's defect for anything unmodeled.
 *
 * The three arms are the ones an application triages. Everything else — a
 * syntax error, a dead connection, a deadlock — is infrastructure a caller
 * cannot act on differently, and belongs on the defect channel where an
 * unexpected failure already goes — unless the caller listed its SQLSTATE in
 * `raises`.
 */
export const qualify = <D, const S extends string = never>(
  cause: unknown,
  defect: (cause: unknown) => D,
  options?: QualifyOptions<S>,
): SqlError | Raised<S> | D => {
  const error = (cause ?? {}) as SqlQueryErrorLike;
  switch (error.sqlState) {
    case "23505":
      return new UniqueConstraintViolation({
        constraint: error.constraint,
        table: error.table,
      });
    case "23503":
      return new ForeignKeyViolation({ constraint: error.constraint, table: error.table });
    case "42501":
      return new NotAuthorized({ table: error.table });
    default: {
      const raised = options?.raises?.find((code) => code === error.sqlState);
      return raised === undefined
        ? defect(cause)
        : (new RaisedException({
            sqlState: raised,
            message: error.message,
            constraint: error.constraint,
            table: error.table,
          }) as Raised<S>);
    }
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
 *   tryQuery(() => db.orm.orders.Order.create({ orderId: order.id })).mapErrCases(
 *     (matcher, defect) =>
 *       matcher
 *         .with(P.tag("UniqueConstraintViolation"), () => new DuplicateOrder({ id: order.id }))
 *         .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
 *         .with(P.tag("NotAuthorized"), (refused) => defect(refused)),
 *   );
 * ```
 *
 * A trigger's own refusal arrives as a {@link RaisedException} once its
 * SQLSTATE is listed:
 *
 * ```ts
 * tryQuery(() => db.orm.orders.Order.create(row), { raises: ["OR001"] });
 * ```
 */
export const tryQuery = <T, const S extends string = never>(
  run: () => PromiseLike<T>,
  options?: QualifyOptions<S>,
): AsyncResult<T, SqlError | Raised<S>> => {
  const qualified = fromPromise(
    // `Promise.resolve().then(run)` rather than `run()`: a thunk that throws
    // SYNCHRONOUSLY would otherwise escape past `fromPromise` as a real throw,
    // which is exactly the channel this function exists to close.
    Promise.resolve().then(run),
    (cause, defect) => qualify<ReturnType<typeof defect>, string>(cause, defect, options),
  );
  // Qualified over `string` and narrowed back: `fromPromise`'s guard and its
  // `Exclude<…, Defect>` cannot see through `Raised<S>` while `S` is generic.
  return qualified as AsyncResult<T, SqlError | Raised<S>>;
};
