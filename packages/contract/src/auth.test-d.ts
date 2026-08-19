import { describe, test } from "vitest";

import type { Authenticated, IsMarked, PrincipalKey } from "./auth.js";

type Fragment = { readonly place: { readonly kind: "procedure" } };
type Expect<T extends true> = T;

describe("Authenticated carries the contract's own keys plus the phantom one", () => {
  test("Exclude<keyof Authenticated<T>, PrincipalKey> is exactly keyof T", () => {
    const same = null as unknown as Exclude<keyof Authenticated<Fragment>, PrincipalKey>;
    const fragmentKey: keyof Fragment = same;
    void fragmentKey;
  });

  test("IsMarked is exactly true for a marked node", () => {
    // Both directions: `boolean` would satisfy assignability to `true` alone.
    const exact = null as unknown as Expect<
      [IsMarked<Authenticated<Fragment>>] extends [true]
        ? [true] extends [IsMarked<Authenticated<Fragment>>]
          ? true
          : false
        : false
    >;
    void exact;
  });

  test("IsMarked is exactly false for a node carrying no marker", () => {
    const exact = null as unknown as Expect<
      [IsMarked<Fragment>] extends [false]
        ? [false] extends [IsMarked<Fragment>]
          ? true
          : false
        : false
    >;
    void exact;
  });

  test("a marked node still satisfies the plain contract shape", () => {
    const marked = null as unknown as Authenticated<Fragment>;
    const plain: Fragment = marked;
    void plain;
  });

  test("a plain node does not satisfy the marked shape", () => {
    const plain = null as unknown as Fragment;
    // @ts-expect-error a plain node carries no [PrincipalKey]
    const marked: Authenticated<Fragment> = plain;
    void marked;
  });
});
