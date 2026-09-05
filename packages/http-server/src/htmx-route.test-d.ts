// `context.unit` on a fragment route: the record is declared once at the mint,
// and the kind the route's own `requires` selects decides which of its names
// are properties at all. Each `@ts-expect-error` is an assertion — if one
// stops erroring, the filtering is gone.
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";

import { HttpAuthenticator } from "./auth.js";
import { defineHttp } from "./define-http.js";
import { html } from "./html.js";

const api = defineHttp({
  authenticators: {
    user: HttpAuthenticator<{ readonly userId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ userId: "u-1" }),
    }),
    service: HttpAuthenticator<{ readonly appId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ appId: "a-1" }),
    }),
  },
});

class RouteSpan extends Port("RouteSpan")<{ readonly finish: () => void }> {}
class RouteTenant extends Port("RouteTenant")<string> {}

const AnonymousUnit = Module("RouteAnonymousUnit")({
  provides: [Provider(RouteSpan)({ inject: {}, sync: () => ({ finish: () => undefined }) })],
  exports: [RouteSpan],
});

const UserUnit = Module("RouteUserUnit")({
  needs: [api.principals.user],
  imports: [AnonymousUnit],
  provides: [
    Provider(RouteTenant)({
      inject: { principal: api.principals.user },
      sync: ({ principal }) => principal.userId,
    }),
  ],
  exports: [RouteTenant, AnonymousUnit],
});

// `service` is a declared scheme that binds NO module, so its routes fall back
// to `anonymous` — the runtime rule, restated in the types.
const kinded = api.units<{ anonymous: typeof AnonymousUnit; user: typeof UserUnit }>();

const record = { span: RouteSpan, tenant: RouteTenant };

// A route requiring `user` opens the module that kind bound, and sees both.
void kinded.HtmxGet("/profile", { requires: [{ user: [] }] })({
  inject: {},
  unit: record,
  sync: () => (context) => {
    context.unit.span.finish();
    const tenant: string = context.unit.tenant;
    return OkAsync(html`<p>${tenant}</p>`);
  },
});

// A route with no `requires` opens `anonymous`, which exports the span alone.
void kinded.HtmxGet("/public")({
  inject: {},
  unit: record,
  sync: () => (context) => {
    context.unit.span.finish();
    // @ts-expect-error — `tenant` is absent: the anonymous kind's module does not export it
    void context.unit.tenant;
    return OkAsync(html`<p>ok</p>`);
  },
});

// Two schemes on one `requires` is the runtime's OR, so the route sees what
// BOTH forked modules export — `service` falls back to anonymous, leaving the
// span alone as the intersection the runtime can actually satisfy.
void kinded.HtmxPost("/either", { requires: [{ user: [] }, { service: [] }] })({
  inject: {},
  unit: record,
  sync: () => (context) => {
    context.unit.span.finish();
    // @ts-expect-error — `tenant`: the `service` kind falls back to anonymous, which does not export it
    void context.unit.tenant;
    return OkAsync(html`<p>ok</p>`);
  },
});

// Without `units<…>()` no kind binds a module, so every name is filtered out —
// which is what keeps a route declaring no `unit:` compiling as it always did.
void api.HtmxGet("/unbound", { requires: [{ user: [] }] })({
  inject: {},
  unit: record,
  sync: () => (context) => {
    // @ts-expect-error — no kinds bound: `span` is absent
    void context.unit.span;
    return OkAsync(html`<p>${context.principal.userId}</p>`);
  },
});

// A route declaring no `unit:` at all still carries a record — the empty one —
// so `HtmxFragments` reads the same field off every piece.
const plain = kinded.HtmxGet("/plain")({
  inject: {},
  sync: () => (context) => {
    void context.unit;
    return OkAsync(html`<p>ok</p>`);
  },
});
type Expect<T extends true> = T;
type _EmptyUnitRecord = Expect<keyof typeof plain.unit extends never ? true : false>;
