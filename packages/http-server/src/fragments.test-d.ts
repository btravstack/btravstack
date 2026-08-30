import { describe, test } from "vitest";

import type { ParamsOf } from "./fragments.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("ParamsOf", () => {
  test("names one parameter", () => {
    type _ = Expect<Equal<ParamsOf<"/orders/:id/row">, { readonly id: string }>>;
  });

  test("names two parameters", () => {
    type Bound = ParamsOf<"/tenants/:tenant/orders/:id">;
    type _tenant = Expect<Equal<Bound["tenant"], string>>;
    type _id = Expect<Equal<Bound["id"], string>>;
  });

  test("a literal path names none", () => {
    type _ = Expect<Equal<ParamsOf<"/orders">, Record<never, never>>>;
  });
});
