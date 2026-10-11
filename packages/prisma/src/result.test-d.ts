// What `raises` promises at the type level: listing nothing changes nothing —
// the error channel is still the three arms, so every exhaustive
// `mapErrCases` written before the option existed compiles as it did — and a
// listed SQLSTATE is one more arm, typed by its own code, which a match must
// then name.
import { P, type AsyncResult } from "unthrown";

import { tryQuery, type RaisedException, type SqlError } from "./result.js";
import { tenantPinned } from "./rls.js";

type Expect<T extends true> = T;
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

declare const insert: () => Promise<number>;

// 1. No `raises`, no new arm: the channel is exactly the three it always was.
const plain = tryQuery(insert);
type _Plain = Expect<Exactly<typeof plain, AsyncResult<number, SqlError>>>;

// 2. So a match naming only the three is still exhaustive.
const triaged: AsyncResult<number, never> = plain.mapErrCases((matcher, defect) =>
  matcher.with(
    P.tag("UniqueConstraintViolation"),
    P.tag("ForeignKeyViolation"),
    P.tag("NotAuthorized"),
    (e) => defect(e),
  ),
);
void triaged;

// 3. A listed code is one arm, carrying that code as its `sqlState`.
const guarded = tryQuery(insert, { raises: ["OR001"] });
type _Guarded = Expect<
  Exactly<typeof guarded, AsyncResult<number, SqlError | RaisedException<"OR001">>>
>;

// 4. Two codes are two arms, so a caller can tell its guards apart.
const both = tryQuery(insert, { raises: ["OR001", "OR002"] });
type _Both = Expect<
  Exactly<
    typeof both,
    AsyncResult<number, SqlError | RaisedException<"OR001"> | RaisedException<"OR002">>
  >
>;

// 5. And a match that forgets the listed code no longer compiles.
void guarded.mapErrCases((matcher, defect) =>
  // @ts-expect-error — `RaisedException<"OR001">` has no arm
  matcher.with(
    P.tag("UniqueConstraintViolation"),
    P.tag("ForeignKeyViolation"),
    P.tag("NotAuthorized"),
    (e) => defect(e),
  ),
);

// 6. `tenantPinned` takes the same option beside its `setting`.
declare const db: {
  readonly raw: { readonly sql: unknown };
  readonly transaction: <R>(
    fn: (tx: { readonly query: (plan: never) => Promise<unknown> }) => PromiseLike<R>,
  ) => Promise<R>;
};
const pinned = tenantPinned(db, "acme", () => insert(), { raises: ["OR001"], setting: "app.org" });
type _Pinned = Expect<
  Exactly<typeof pinned, AsyncResult<number, SqlError | RaisedException<"OR001">>>
>;
