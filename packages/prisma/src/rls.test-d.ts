// What `tenantPinned` promises at the type level: the client it takes is
// STRUCTURAL, so a contract-typed client passes without the starter naming one;
// the transaction context reaches the work with its own type intact; and the
// work's answer is what comes back.
//
// Where the v7 `tenantScoped` had to pin an extension's `tx` type and copy
// Prisma's own transaction deny list by hand, there is nothing here to copy:
// the transaction is the client's own, and this function only runs one
// statement inside it.
import type { AsyncResult } from "unthrown";

import type { SqlError } from "./result.js";
import { tenantPinned } from "./rls.js";

type Expect<T extends true> = T;
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A stand-in for the client an emitted contract types. */
type Tx = {
  readonly query: (plan: unknown) => Promise<unknown>;
  readonly orm: {
    readonly public: {
      readonly Order: { readonly all: () => Promise<readonly { readonly id: number }[]> };
    };
  };
};
type Db = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ) => {
      readonly returnsRow: (spec: Readonly<Record<string, string>>) => {
        readonly build: () => unknown;
      };
    };
  };
  readonly transaction: <R>(fn: (tx: Tx) => PromiseLike<R>) => Promise<R>;
};

declare const db: Db;

// 1. The work's `tx` keeps the client's own type — a query surface, not an
//    implicit `any`, which is what the v7 override needed a cast to preserve.
//    The answer is an `AsyncResult`, qualified: thesis #6 has exactly three
//    bare-`Promise` exceptions and this is not a fourth.
const rows = tenantPinned(db, "acme", (tx) => tx.orm.public.Order.all());
type _Rows = Expect<
  Exactly<typeof rows, AsyncResult<readonly { readonly id: number }[], SqlError>>
>;

// 2. The answer is the work's, not the pin's.
const counted = tenantPinned(db, "acme", async (tx) => (await tx.orm.public.Order.all()).length);
type _Counted = Expect<Exactly<typeof counted, AsyncResult<number, SqlError>>>;

// 3. The setting is an option, and it is the one thing that has to agree with
//    the policy.
void tenantPinned(db, "acme", () => Promise.resolve(undefined), { setting: "app.org_id" });

// 4. A client with no raw lane cannot be pinned: there is nothing to build the
//    `set_config` with. `Pinnable` types the tag as `unknown` — a parameter is
//    contravariant, so describing it would refuse every real client — but the
//    PROPERTY is still required, which is what this arm pins.
declare const rawless: { readonly transaction: Db["transaction"] };
// @ts-expect-error — no `raw`, so there is no statement to pin with
void tenantPinned(rawless, "a", () => Promise.resolve(undefined));
