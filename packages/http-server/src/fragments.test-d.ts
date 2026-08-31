import { Port, type PortInstance, type Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { HttpAuthenticator, granted, type AuthenticatorService } from "./auth.js";
import { defineHttp } from "./define-http.js";
import type { ParamsOf } from "./fragments.js";
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

describe("HtmxGet / HtmxPost", () => {
  test("an ungrantable scope on requires is refused, naming the scope", () => {
    const api = defineHttp({
      authenticators: {
        user: HttpAuthenticator<{ readonly userId: string }, "orders:read">()({
          sync: () => () => OkAsync(granted({ userId: "u" }, ["orders:read"])),
        }),
      },
    });
    // @ts-expect-error — UNGRANTABLE SCOPE: `user` cannot grant "orders:write"
    void api.HtmxGet("/orders", { requires: [{ user: ["orders:write"] }] });
    // The positive twin: a grantable scope compiles.
    void api.HtmxGet("/orders", { requires: [{ user: ["orders:read"] }] });
  });

  test("input is unexpressible on a GET route", () => {
    const api = defineHttp();
    // @ts-expect-error — HtmxGet's options carry no `input` field
    void api.HtmxGet("/orders", { input: z.object({ q: z.string() }) });
    void api.HtmxPost("/orders", { input: z.object({ q: z.string() }) });
  });

  test("the path literal types the handler's params", () => {
    const api = defineHttp();
    void api.HtmxGet("/orders/:id/row")({
      sync: () => (_context, params) => {
        const id: string = params.id;
        return OkAsync(html`${id}`);
      },
    });
  });

  test("a route without requires has no principal to read", () => {
    const api = defineHttp();
    void api.HtmxGet("/ping")({
      // @ts-expect-error — no requires, so `context` has no `principal`
      sync: () => (context) => OkAsync(html`${context.principal}`),
    });
  });
});

describe("HtmxFragments scheme needs", () => {
  type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
  type SchemePort<S extends string> = S extends string
    ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
    : never;

  test("declares one port per scheme any route's requires names — two, one, and none, each both ways", () => {
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

    const twoSchemeComposed = api.HtmxFragments([
      api.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })({
        sync: () => () => OkAsync(html``),
      }),
      api.HtmxGet("/admin", { requires: [{ service: [] }] })({
        sync: () => () => OkAsync(html``),
      }),
    ]);

    const oneSchemeComposed = api.HtmxFragments([
      api.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })({
        sync: () => () => OkAsync(html``),
      }),
    ]);

    const noSchemeComposed = api.HtmxFragments([
      api.HtmxGet("/ping")({ sync: () => () => OkAsync(html``) }),
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

describe("HtmxGet / HtmxPost deps arm", () => {
  test("the deps arm types its service and declares it as a need, both ways", () => {
    class FindOrder extends Port("FindOrder")<(id: string) => string> {}
    const api = defineHttp();

    const row = api.HtmxGet("/orders/:id/row")(
      { find: FindOrder },
      {
        sync:
          ({ find }) =>
          (_context, params) => {
            expectTypeOf(find).toEqualTypeOf<(id: string) => string>();
            return OkAsync(html`${find(params.id)}`);
          },
      },
    );

    type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
    // BOTH directions — a one-way check passes on a collapsed `never`.
    type _Needs = Expect<
      [NeedsOf<typeof row>] extends [InstanceType<typeof FindOrder>]
        ? [InstanceType<typeof FindOrder>] extends [NeedsOf<typeof row>]
          ? true
          : false
        : false
    >;
  });
});
