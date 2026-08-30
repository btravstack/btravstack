import { OkAsync } from "unthrown";
import { describe, test } from "vitest";

import { defineHttp } from "./define-http.js";
import { defineFragments, type ParamsOf } from "./fragments.js";
import { html } from "./html.js";

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

describe("HtmxFragments", () => {
  test("refuses an array that leaves a declared key uncovered", () => {
    const fragments = defineFragments({
      orderRow: { method: "GET", path: "/orders/:id/row" },
      orderList: { method: "GET", path: "/orders" },
    });
    const api = defineHttp();
    const row = api.HtmxController(
      fragments,
      "orderRow",
    )({
      sync: () => () => OkAsync(html`<tr></tr>`),
    });
    // @ts-expect-error orderList is declared and no piece covers it
    void api.HtmxFragments(fragments)([row]);
  });

  test("accepts an array covering every declared key", () => {
    const fragments = defineFragments({
      orderRow: { method: "GET", path: "/orders/:id/row" },
      orderList: { method: "GET", path: "/orders" },
    });
    const api = defineHttp();
    const row = api.HtmxController(
      fragments,
      "orderRow",
    )({
      sync: () => () => OkAsync(html`<tr></tr>`),
    });
    const list = api.HtmxController(
      fragments,
      "orderList",
    )({
      sync: () => () => OkAsync(html`<ul></ul>`),
    });
    void api.HtmxFragments(fragments)([row, list]);
  });
});
