// The type half of the auth marker: a marked contract node types its handler's
// principal on oRPC's own context channel, and an unmarked one does not. Each
// `@ts-expect-error` is an assertion: if one stops erroring, the gate is gone.
import { auth, type Authenticated } from "@btravstack/contract";
import { start } from "@btravstack/core";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";

import { HttpAuthenticator } from "./auth.js";
import { HttpController } from "./controller.js";
import { httpAuth } from "./http-auth.js";
import { HttpModule } from "./http-module.js";
import { HttpRouter, type ContractPrincipal, type Implementation } from "./orpc.js";

type Principal = { readonly userId: string; readonly tenantId: string };
const { authenticated } = auth<Principal>();

const contract = {
  orders: authenticated({ place: oc }),
  health: { ping: oc },
  quote: authenticated(oc),
};

type Expect<T extends true> = T;
type HandlerContext<H> = H extends (opts: infer O, ...rest: never) => unknown
  ? O extends { readonly context: infer Ctx }
    ? Ctx
    : never
  : never;

type OrdersImpl = Implementation<(typeof contract)["orders"]>;
type HealthImpl = Implementation<(typeof contract)["health"]>;
type QuoteImpl = Implementation<(typeof contract)["quote"]>;

// 1. A marked RECORD pushes its marker onto every procedure beneath it, and the
//    principal arrives on `opts.context` — oRPC's own channel, no second
//    handler parameter added by this package.
declare const ordersContext: HandlerContext<OrdersImpl["place"]>;
const _inherited: Principal = ordersContext.principal;

// 2. A marked PROCEDURE protects itself.
declare const quoteContext: HandlerContext<QuoteImpl>;
const _leaf: Principal = quoteContext.principal;

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
const _none: Principal = healthContext.principal;

// 5. The principal a contract declares is found through the nesting — pinned
//    both ways, since assignability alone would also hold if it widened.
type _FoundPrincipal = Expect<
  [ContractPrincipal<typeof contract>] extends [Principal]
    ? [Principal] extends [ContractPrincipal<typeof contract>]
      ? true
      : false
    : false
>;

// 6. An all-public contract declares no principal at all.
// @ts-expect-error — `ContractPrincipal` of an unmarked tree is `never`
const _absent: ContractPrincipal<{ readonly health: { readonly ping: typeof oc } }> = {};

void _inherited;
void _leaf;
void _none;
void _absent;

// The composition half: a marked contract needs an authenticator, and the
// composition root is where the router and the authenticator meet. The two
// gates below are DIFFERENT gates, and fire at different calls. Whether an
// authenticator is there at all is di's own `UNSATISFIED DEPENDENCIES` at
// `start` (7) — the same arm `examples/order-api/src/needs-gate.test-d.ts`
// pins for the router. Whether it resolves the contract's principal is this
// package's own options check at the `HttpModule(...)` call (8), because
// `AuthenticatorPort`'s service type is erased to `AuthenticatorService<
// unknown>`: the need cannot carry the principal, so only the options type
// can compare it.
const markedRouter = HttpRouter({ orders: contract.orders, health: contract.health })([], {
  sync: () => ({
    orders: { place: ({ context }) => OkAsync({ id: context.principal.userId }) },
    health: { ping: () => OkAsync({ ok: true as const }) },
  }),
});

const matching = HttpAuthenticator<Principal>()([], {
  sync: () => () => OkAsync({ userId: "u", tenantId: "t" }),
});
const other = HttpAuthenticator<{ readonly sub: string }>()([], {
  sync: () => () => OkAsync({ sub: "s" }),
});

const options = { signals: false, probes: false } as const;

// 7. A marked router with no authenticator supplied carries the port as an
//    unmet need — the module builds, `start` refuses it.
const MissingApi = HttpModule("Missing")({ router: markedRouter });
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides the authenticator port the marked router needs.
const _missing = start(MissingApi, options);

// 8. An authenticator whose principal is not the contract's is refused. Unlike
//    7, this one is NOT di's gate and does not wait for `start`: the
//    authenticator port's service type is erased to `unknown`, so di sees the
//    need discharged. The principals meet on `HttpModule`'s own options —
//    `Principal` is inferred from the router — which is where it is caught.
// @ts-expect-error — the authenticator's principal is not the contract's.
const MismatchedApi = HttpModule("Mismatched")({ router: markedRouter, authenticator: other });

// 9. The matching pair compiles.
const WiredApi = HttpModule("Wired")({ router: markedRouter, authenticator: matching });
const _wired = start(WiredApi, options);

// 10. An unmarked router with an authenticator supplied is not this package's
//     error to raise: di decides, and a provider nothing needs is no defect.
const publicRouter = HttpRouter({ health: contract.health })([], {
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
//     under it reads the principal the root mark declares. The keyed overload
//     must therefore `Exclude` the phantom key from the keys it demands (or the
//     record can never be complete) and `Inherit` the root's mark down to each
//     fragment (or no controller under it could type `context.principal`) —
//     both of which the positional arm already did. `contract.orders` above
//     marks a KEY, so neither omission showed there.
declare const ordersFragment: Authenticated<{ readonly whoami: typeof oc }, Principal>;
const rootOrders = HttpController("RootOrders", ordersFragment)([], {
  sync: () => ({ whoami: ({ context }) => OkAsync(context.principal.userId) }),
});
const rootMarkedContract = authenticated({ orders: { whoami: oc } });
const _rootKeyed = HttpModule("RootKeyed")({
  router: HttpRouter(rootMarkedContract)({ orders: rootOrders }),
  authenticator: matching,
});

void _rootKeyed;

// The server-side factory. The contract declares the client-visible minimum —
// `{ tenantId }` — and says WHETHER a route is protected; `httpAuth<Identity>()`
// says WHAT the principal is, server-side, and a handler minted from it sees
// that. Each arm below is spelled against `scopedContract`, whose principal is
// deliberately narrower than the identity the server resolves.
type Tenant = { readonly tenantId: string };
const { authenticated: scoped } = auth<Tenant>();
const scopedContract = { orders: scoped({ place: oc }), health: { ping: oc } };

type Identity = Tenant & { readonly userId: string };
const {
  HttpController: IdentityController,
  HttpRouter: IdentityRouter,
  HttpAuthenticator: IdentityAuthenticator,
} = httpAuth<Identity>();

// 12. A factory-minted controller's MARKED handler sees the factory's identity,
//     including a field the contract declares nowhere.
const scopedOrders = IdentityController("ScopedOrders", scopedContract.orders)([], {
  sync: () => ({ place: ({ context }) => OkAsync(context.principal.userId) }),
});

// 13. The top-level `HttpController` is unchanged: the same fragment types the
//     CONTRACT's principal, which has no `userId`.
void HttpController("ContractOrders", scopedContract.orders)([], {
  // @ts-expect-error — `userId` is the server's identity, not the contract's principal
  sync: () => ({ place: ({ context }) => OkAsync(context.principal.userId) }),
});

// 14. A factory invents no principal on an UNMARKED fragment: the identity
//     replaces the contract's type where there is one, and adds none where
//     there is not.
void IdentityController("ScopedHealth", scopedContract.health)([], {
  // @ts-expect-error — `principal` is not on an unmarked handler's context
  sync: () => ({ ping: ({ context }) => OkAsync(context.principal.tenantId) }),
});

// 15. A factory-minted router composes factory-minted controllers, and the
//     `HttpModule` gate still checks the authenticator against the CONTRACT's
//     principal — which an identity richer than it satisfies as a subtype.
const scopedHealth = IdentityController("ScopedHealthOk", scopedContract.health)([], {
  sync: () => ({ ping: () => OkAsync({ ok: true as const }) }),
});
const identityAuthenticator = IdentityAuthenticator([], {
  sync: () => () => OkAsync({ tenantId: "t", userId: "u" }),
});
const _scoped = HttpModule("Scoped")({
  router: IdentityRouter(scopedContract)({ orders: scopedOrders, health: scopedHealth }),
  authenticator: identityAuthenticator,
  provides: [scopedOrders, scopedHealth],
});

// 16. An authenticator whose identity does not satisfy the contract's principal
//     is still refused, factory or not.
const strayAuthenticator = HttpAuthenticator<{ readonly sub: string }>()([], {
  sync: () => () => OkAsync({ sub: "s" }),
});
const _strayScoped = HttpModule("StrayScoped")({
  router: IdentityRouter(scopedContract)({ orders: scopedOrders, health: scopedHealth }),
  // @ts-expect-error — the authenticator's principal is not the contract's
  authenticator: strayAuthenticator,
});

void _scoped;
void _strayScoped;
