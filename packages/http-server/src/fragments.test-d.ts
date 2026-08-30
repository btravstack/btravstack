import { authenticated } from "@btravstack/contract";
import type { PortInstance, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, test } from "vitest";

import { HttpAuthenticator, type AuthenticatorService } from "./auth.js";
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

describe("HtmxFragments principal typing", () => {
  test("an unmarked route's context carries no principal at all", () => {
    const fragments = defineFragments({ ping: { method: "GET", path: "/ping" } });
    const api = defineHttp();
    void api.HtmxController(
      fragments,
      "ping",
    )({
      // @ts-expect-error — the contract is unmarked, so `context` has no `principal` to read
      sync: () => (context) => OkAsync(html`${context.principal}`),
    });
  });

  test("a piece minted over a marked route cannot be composed where an unmarked one is expected", () => {
    const api = defineHttp({
      authenticators: {
        user: HttpAuthenticator<{ readonly userId: string }>()({
          sync: () => () => OkAsync({ userId: "u-1" }),
        }),
      },
    });

    // One route marked, one not — the mixed shape `markedOrderRow` and
    // `unmarkedPing` are minted from.
    const mixed = defineFragments({
      orderRow: authenticated({ user: [] })({ method: "GET", path: "/orders/:id/row" }),
      ping: { method: "GET", path: "/ping" },
    });
    const markedOrderRow = api.HtmxController(
      mixed,
      "orderRow",
    )({
      sync: () => (context) => OkAsync(html`${context.principal.userId}`),
    });
    const unmarkedPing = api.HtmxController(
      mixed,
      "ping",
    )({
      sync: () => () => OkAsync(html``),
    });

    // The accepted direction: a handler that reads no principal is
    // contravariantly fine alongside one that does, under the mixed contract
    // both pieces were minted from.
    void api.HtmxFragments(mixed)([markedOrderRow, unmarkedPing]);

    // The refused direction: `markedOrderRow` needs a principal a structurally
    // identical but fully UNMARKED contract declares nowhere.
    const fullyUnmarked = defineFragments({
      orderRow: { method: "GET", path: "/orders/:id/row" },
      ping: { method: "GET", path: "/ping" },
    });
    // @ts-expect-error — `markedOrderRow` needs a principal `fullyUnmarked` declares nowhere
    void api.HtmxFragments(fullyUnmarked)([markedOrderRow, unmarkedPing]);
  });
});

describe("HtmxFragments scheme needs", () => {
  type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
  type SchemePort<S extends string> = S extends string
    ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
    : never;

  test("declares one port per scheme any route or the contract itself names — two, one, and none, each both ways", () => {
    const api = defineHttp({
      authenticators: {
        user: HttpAuthenticator<{ readonly userId: string }>()({
          sync: () => () => OkAsync({ userId: "u-1" }),
        }),
        service: HttpAuthenticator<{ readonly appId: string }>()({
          sync: () => () => OkAsync({ appId: "a-1" }),
        }),
      },
    });

    const twoSchemes = authenticated({ user: [] })(
      defineFragments({
        orderRow: { method: "GET", path: "/orders/:id/row" },
        adminOnly: authenticated({ service: [] })({ method: "GET", path: "/admin" }),
      }),
    );
    const twoSchemeComposed = api.HtmxFragments(twoSchemes)([
      api.HtmxController(twoSchemes, "orderRow")({ sync: () => () => OkAsync(html``) }),
      api.HtmxController(twoSchemes, "adminOnly")({ sync: () => () => OkAsync(html``) }),
    ]);

    const oneScheme = authenticated({ user: [] })(
      defineFragments({ orderRow: { method: "GET", path: "/orders/:id/row" } }),
    );
    const oneSchemeComposed = api.HtmxFragments(oneScheme)([
      api.HtmxController(oneScheme, "orderRow")({ sync: () => () => OkAsync(html``) }),
    ]);

    const noScheme = defineFragments({ ping: { method: "GET", path: "/ping" } });
    const noSchemeComposed = api.HtmxFragments(noScheme)([
      api.HtmxController(noScheme, "ping")({ sync: () => () => OkAsync(html``) }),
    ]);

    // BOTH directions, for each — a one-way check passes on a collapsed
    // `never`, which is how a broken scheme walk would slip through.
    type _TwoSchemeNeeds = Expect<
      [Extract<NeedsOf<typeof twoSchemeComposed>, SchemePort<string>>] extends [
        SchemePort<"user" | "service">,
      ]
        ? [SchemePort<"user" | "service">] extends [NeedsOf<typeof twoSchemeComposed>]
          ? true
          : false
        : false
    >;
    type _OneSchemeNeeds = Expect<
      [Extract<NeedsOf<typeof oneSchemeComposed>, SchemePort<string>>] extends [SchemePort<"user">]
        ? [SchemePort<"user">] extends [NeedsOf<typeof oneSchemeComposed>]
          ? true
          : false
        : false
    >;
    type _NoSchemeNeeds = Expect<
      [Extract<NeedsOf<typeof noSchemeComposed>, SchemePort<string>>] extends [never] ? true : false
    >;
  });
});
