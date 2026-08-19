// The type half of the auth marker: a marked contract node types its handler's
// principal on oRPC's own context channel, and an unmarked one does not. Each
// `@ts-expect-error` is an assertion: if one stops erroring, the gate is gone.
import { authenticated, type Authenticated } from "@btravstack/contract";
import { start } from "@btravstack/core";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";

import { HttpAuthenticator } from "./auth.js";
import { HttpController } from "./controller.js";
import { httpAuth } from "./http-auth.js";
import { HttpModule } from "./http-module.js";
import { HttpRouter, type HasMark, type Implementation } from "./orpc.js";

type Identity = { readonly userId: string; readonly tenantId: string };

const contract = {
  orders: authenticated({ place: oc }),
  health: { ping: oc },
  quote: authenticated(oc),
};

const {
  HttpController: IdentityController,
  HttpRouter: IdentityRouter,
  HttpAuthenticator: IdentityAuthenticator,
} = httpAuth<Identity>();

type Expect<T extends true> = T;
type HandlerContext<H> = H extends (opts: infer O, ...rest: never) => unknown
  ? O extends { readonly context: infer Ctx }
    ? Ctx
    : never
  : never;

type OrdersImpl = Implementation<(typeof contract)["orders"], Identity>;
type HealthImpl = Implementation<(typeof contract)["health"], Identity>;
type QuoteImpl = Implementation<(typeof contract)["quote"], Identity>;

// 1. A marked RECORD pushes its marker onto every procedure beneath it, and the
//    factory's identity arrives on `opts.context` — oRPC's own channel, no
//    second handler parameter added by this package.
declare const ordersContext: HandlerContext<OrdersImpl["place"]>;
const _inherited: Identity = ordersContext.principal;

// 2. A marked PROCEDURE protects itself.
declare const quoteContext: HandlerContext<QuoteImpl>;
const _leaf: Identity = quoteContext.principal;

// 3. The marker's phantom key never becomes a procedure key.
type _OrdersKeys = Expect<
  [keyof OrdersImpl] extends ["place"]
    ? ["place"] extends [keyof OrdersImpl]
      ? true
      : false
    : false
>;

// 4. An unmarked procedure's context carries no principal.
declare const healthContext: HandlerContext<HealthImpl["ping"]>;
// @ts-expect-error — `principal` is not on an unmarked handler's context
const _none: Identity = healthContext.principal;

// 5. `HasMark` finds a mark through the nesting, and is EXACTLY `true` — a
//    `boolean` result would satisfy both this assertion and its opposite.
type _Marked = Expect<
  [HasMark<typeof contract>] extends [true]
    ? [true] extends [HasMark<typeof contract>]
      ? true
      : false
    : false
>;

// 6. An all-public contract is exactly `false`, on the same footing.
type _Unmarked = Expect<
  [HasMark<{ readonly health: { readonly ping: typeof oc } }>] extends [false]
    ? [false] extends [HasMark<{ readonly health: { readonly ping: typeof oc } }>]
      ? true
      : false
    : false
>;

void _inherited;
void _leaf;
void _none;

// The composition half: a marked contract needs an authenticator, and the
// composition root is where the router and the authenticator meet. The two
// gates below are DIFFERENT gates, and fire at different calls. Whether an
// authenticator is there at all is di's own `UNSATISFIED DEPENDENCIES` at
// `start` (7) — the same arm `examples/order-api/src/needs-gate.test-d.ts`
// pins for the router. Whether it resolves what the handlers read is this
// package's own options check at the `HttpModule(...)` call (8), because
// `AuthenticatorPort`'s service type is erased to `AuthenticatorService<
// unknown>`: the need cannot carry the identity, so only the options type
// can compare it — the ROUTER's identity against the AUTHENTICATOR's, since
// the contract declares none.
const markedRouter = IdentityRouter({ orders: contract.orders, health: contract.health })([], {
  sync: () => ({
    orders: { place: ({ context }) => OkAsync({ id: context.principal.userId }) },
    health: { ping: () => OkAsync({ ok: true as const }) },
  }),
});

const matching = IdentityAuthenticator([], {
  sync: () => () => OkAsync({ userId: "u", tenantId: "t" }),
});
const other = httpAuth<{ readonly sub: string }>().HttpAuthenticator([], {
  sync: () => () => OkAsync({ sub: "s" }),
});

const options = { signals: false, probes: false } as const;

// 7. A marked router with no authenticator supplied carries the port as an
//    unmet need — the module builds, `start` refuses it.
const MissingApi = HttpModule("Missing")({ router: markedRouter });
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides the authenticator port the marked router needs.
const _missing = start(MissingApi, options);

// 8. An authenticator minted on a DIFFERENT identity is refused. Unlike 7,
//    this one is NOT di's gate and does not wait for `start`: the
//    authenticator port's service type is erased to `unknown`, so di sees the
//    need discharged. The two identities meet on `HttpModule`'s own options —
//    `RouterIdentity` is inferred from the router — which is where it is caught.
// @ts-expect-error — the authenticator's identity is not the router's.
const MismatchedApi = HttpModule("Mismatched")({ router: markedRouter, authenticator: other });

// 9. The matching pair compiles.
const WiredApi = HttpModule("Wired")({ router: markedRouter, authenticator: matching });
const _wired = start(WiredApi, options);

// 10. An unmarked router with an authenticator supplied is not this package's
//     error to raise: di decides, and a provider nothing needs is no defect.
const publicRouter = IdentityRouter({ health: contract.health })([], {
  sync: () => ({ health: { ping: () => OkAsync({ ok: true as const }) } }),
});
const _public = start(
  HttpModule("Public")({ router: publicRouter, authenticator: matching }),
  options,
);

void _missing;
void MismatchedApi;
void _wired;
void _public;

// 11. A ROOT-marked contract composes through the KEYED form, and a controller
//     under it reads the identity the factory declares. The keyed overload
//     must therefore `Exclude` the phantom key from the keys it demands (or the
//     record can never be complete) and `Inherit` the root's mark down to each
//     fragment (or no controller under it could type `context.principal`) —
//     both of which the positional arm already did. `contract.orders` above
//     marks a KEY, so neither omission showed there.
declare const ordersFragment: Authenticated<{ readonly whoami: typeof oc }>;
const rootOrders = IdentityController("RootOrders", ordersFragment)([], {
  sync: () => ({ whoami: ({ context }) => OkAsync(context.principal.userId) }),
});
const rootMarkedContract = authenticated({ orders: { whoami: oc } });
const _rootKeyed = HttpModule("RootKeyed")({
  router: IdentityRouter(rootMarkedContract)({ orders: rootOrders }),
  authenticator: matching,
});

void _rootKeyed;

// The contract says WHETHER a route is protected; the factory says WHAT the
// principal is. The arms below are what makes that division checkable: an
// identity a contract could never have named, and the top-level form — which
// names none — refusing to invent one.

// 12. A factory-minted controller's MARKED handler sees the factory's identity,
//     a type the contract declares nowhere.
const scopedOrders = IdentityController("ScopedOrders", contract.orders)([], {
  sync: () => ({ place: ({ context }) => OkAsync(context.principal.tenantId) }),
});

// 13. The top-level `HttpController` mints no identity, so the same marked
//     fragment types `principal: never` — the "use the factory" signal, since
//     any read of it is a compile error.
void HttpController("ContractOrders", contract.orders)([], {
  // @ts-expect-error — no factory, so there is no principal type to read
  sync: () => ({ place: ({ context }) => OkAsync(context.principal.userId) }),
});

// 14. A factory invents no principal on an UNMARKED fragment: the identity
//     reaches a marked leaf and no other.
void IdentityController("ScopedHealth", contract.health)([], {
  // @ts-expect-error — `principal` is not on an unmarked handler's context
  sync: () => ({ ping: ({ context }) => OkAsync(context.principal.tenantId) }),
});

// 15. A factory-minted router composes factory-minted controllers, and the
//     `HttpModule` gate checks the authenticator against the ROUTER's identity.
const scopedHealth = IdentityController("ScopedHealthOk", contract.health)([], {
  sync: () => ({ ping: () => OkAsync({ ok: true as const }) }),
});
const _scoped = HttpModule("Scoped")({
  router: IdentityRouter({ orders: contract.orders, health: contract.health })({
    orders: scopedOrders,
    health: scopedHealth,
  }),
  authenticator: matching,
  provides: [scopedOrders, scopedHealth],
});

// 16. An authenticator minted on another identity is still refused, and a
//     hand-written `HttpAuthenticator<P>()` is no way around it.
const strayAuthenticator = HttpAuthenticator<{ readonly sub: string }>()([], {
  sync: () => () => OkAsync({ sub: "s" }),
});
const _strayScoped = HttpModule("StrayScoped")({
  router: IdentityRouter({ orders: contract.orders, health: contract.health })({
    orders: scopedOrders,
    health: scopedHealth,
  }),
  // @ts-expect-error — the authenticator's identity is not the router's
  authenticator: strayAuthenticator,
});

void _scoped;
void _strayScoped;
