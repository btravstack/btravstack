import { describe, test } from "vitest";

import type { Authenticated, PrincipalKey, PrincipalOf } from "./auth.js";

type Fragment = { readonly place: { readonly kind: "procedure" } };
type Principal = { readonly userId: string };

describe("Authenticated carries the contract's own keys plus the phantom one", () => {
  test("Exclude<keyof Authenticated<T, P>, PrincipalKey> is exactly keyof T", () => {
    const same = null as unknown as Exclude<keyof Authenticated<Fragment, Principal>, PrincipalKey>;
    const fragmentKey: keyof Fragment = same;
    void fragmentKey;
  });

  test("PrincipalOf recovers the principal a node was marked with", () => {
    const principal = null as unknown as PrincipalOf<Authenticated<Fragment, Principal>>;
    const recovered: Principal = principal;
    void recovered;
  });

  test("PrincipalOf is never for a node carrying no marker", () => {
    // @ts-expect-error PrincipalOf<Fragment> is `never`, nothing is assignable to it
    const wrong: PrincipalOf<Fragment> = { userId: "x" } satisfies Principal;
    void wrong;
  });

  test("a marked node still satisfies the plain contract shape", () => {
    const marked = null as unknown as Authenticated<Fragment, Principal>;
    const plain: Fragment = marked;
    void plain;
  });

  test("a plain node does not satisfy the marked shape", () => {
    const plain = null as unknown as Fragment;
    // @ts-expect-error a plain node carries no [PrincipalKey]
    const marked: Authenticated<Fragment, Principal> = plain;
    void marked;
  });
});
