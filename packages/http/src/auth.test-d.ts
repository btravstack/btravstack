// The type half of the auth marker: a marked contract node types its handler's
// principal on oRPC's own context channel, and an unmarked one does not. Each
// `@ts-expect-error` is an assertion: if one stops erroring, the gate is gone.
import { auth } from "@btravstack/contract";
import { oc } from "@orpc/contract";

import type { ContractPrincipal, Implementation } from "./orpc.js";

type Principal = { readonly userId: string; readonly tenantId: string };
const { authenticated } = auth<Principal>();

const contract = {
  orders: authenticated({ place: oc }),
  health: { ping: oc },
  quote: authenticated(oc),
};

type Expect<T extends true> = T;
type ContextOf<H> = H extends (opts: infer O, ...rest: never) => unknown
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
declare const ordersContext: ContextOf<OrdersImpl["place"]>;
const _inherited: Principal = ordersContext.principal;

// 2. A marked PROCEDURE protects itself.
declare const quoteContext: ContextOf<QuoteImpl>;
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
declare const healthContext: ContextOf<HealthImpl["ping"]>;
// @ts-expect-error — `principal` is not on an unmarked handler's context
const _none: Principal = healthContext.principal;

// 5. The principal a contract declares is found through the nesting.
const _found: ContractPrincipal<typeof contract> = { userId: "u", tenantId: "t" };

// 6. An all-public contract declares no principal at all.
// @ts-expect-error — `ContractPrincipal` of an unmarked tree is `never`
const _absent: ContractPrincipal<{ readonly health: { readonly ping: typeof oc } }> = {};

void _inherited;
void _leaf;
void _none;
void _found;
void _absent;
