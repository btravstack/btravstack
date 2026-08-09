import { describe, test } from "vitest";

import { Port, Provider, type Context } from "./index.js";
import { type Equal } from "./type-assert.js";

class Handlers extends Port.many("MyHandlers")<{ readonly run: () => void }> {}
class Db extends Port("MDDb")<{ readonly name: string }> {}

/**
 * Recovers `Provider`'s three type arguments by direct positional inference,
 * the same `ChannelsOf` trick `provider.test-d.ts`/`module.test-d.ts` use —
 * `Provider`'s channels sit in contravariant field positions, so a plain
 * `const typed: Provider<X, Y, Z> = p` assignment alone would stay green
 * even if a channel silently widened.
 */
type ChannelsOf<T> = T extends Provider<infer P, infer E, infer N> ? readonly [P, E, N] : never;

describe("Port.many", () => {
  test("get yields an array of the member service shape, not the member itself", () => {
    const ctx = null as unknown as Context<Handlers>;
    const all = ctx.get(Handlers);

    // A plain `const all: readonly {...}[] = ctx.get(Handlers)` (the brief's
    // form, kept as its own test below) only proves the actual return type
    // is assignable *into* that declared array type — a widening to `any`
    // would pass that check regardless. Reading `typeof all` back out and
    // comparing with `Equal` pins the literal inferred type instead.
    type All = typeof all;
    const isMemberArray: Equal<All, readonly { readonly run: () => void }[]> = true;
    const isNotSingleMember: Equal<All, { readonly run: () => void }> = false;
    const isNotUnknownArray: Equal<All, readonly unknown[]> = false;
    void isMemberArray;
    void isNotSingleMember;
    void isNotUnknownArray;
  });

  test("get does not yield a single member", () => {
    const ctx = null as unknown as Context<Handlers>;
    // @ts-expect-error a set port resolves to an array
    const one: { readonly run: () => void } = ctx.get(Handlers);
    void one;
  });
});

describe("Provider.member", () => {
  test("a value member is qualified against the member shape, not the array", () => {
    const p = Provider.member(Handlers)({ value: { run: () => {} } });

    type Channels = ChannelsOf<typeof p>;
    const portIsHandlers: Equal<Channels[0], Handlers> = true;
    const errorIsNever: Equal<Channels[1], never> = true;
    const needsIsNever: Equal<Channels[2], never> = true;
    void portIsHandlers;
    void errorIsNever;
    void needsIsNever;
  });

  test("a value member cannot supply the array shape", () => {
    // @ts-expect-error the member arm wants one Handler, not an array of them
    Provider.member(Handlers)({ value: [{ run: () => {} }] });
  });

  test("deps are typed into the member factory parameters, positionally", () => {
    const p = Provider.member(Handlers)([Db], {
      sync: (db) => ({ run: () => void db.name }),
    });

    type Channels = ChannelsOf<typeof p>;
    const portIsHandlers: Equal<Channels[0], Handlers> = true;
    const needsIsDb: Equal<Channels[2], Db> = true;
    // Negative control: `Needs` must be pinned to exactly `Db`, not merely
    // "not never" — a regression that widened it to `unknown` would
    // otherwise slip past the positive assertion above.
    const needsIsNotNever: Equal<Channels[2], never> = false;
    void portIsHandlers;
    void needsIsDb;
    void needsIsNotNever;
  });

  test("a member factory returning the array shape is rejected", () => {
    Provider.member(Handlers)([Db], {
      // @ts-expect-error sync must return one Handler, not an array of them
      sync: (db) => [{ run: () => void db.name }],
    });
  });

  test("an ordinary, non-array-shaped port has no member shape to construct", () => {
    class NotMany extends Port("MDNotMany")<{ readonly name: string }> {}
    // @ts-expect-error NotMany's service is not an array — MemberOf resolves
    // to never, so no value can satisfy the `value` arm
    Provider.member(NotMany)({ value: { name: "x" } });
  });

  /**
   * Regression test for an unsoundness a review caught: an earlier `MemberOf`
   * keyed off "does `ServiceOf` look like an array" rather than the `[MANY]`
   * brand. `Tags` here is an *ordinary* port whose service happens to be
   * array-shaped — `Tags.many` is `undefined` at runtime, so
   * `build.ts`/`context.ts` treat any provider for it as a single service,
   * not a member. Under the old shape-keyed `MemberOf`, `Provider.member(Tags)`
   * type-checked as if `Tags`' member shape were `string`, so
   * `Provider.member(Tags)({ value: "a" })` compiled clean while landing "a"
   * (not `["a"]`) at runtime — a type-level lie about `ctx.get(Tags)`'s real,
   * `readonly string[]`-typed value. `MemberOf` keyed off `[MANY]` (module-
   * private, unforgeable outside `port.ts`) makes this the same `never`
   * rejection as any other ordinary port.
   */
  test("an ordinary port whose service happens to be array-shaped is not a set port", () => {
    class Tags extends Port("MDTags")<readonly string[]> {}
    // @ts-expect-error Tags is an ordinary port (many is undefined at
    // runtime) despite its array-shaped service — MemberOf must resolve to
    // never here, not `string`
    Provider.member(Tags)({ value: "a" });
  });
});
