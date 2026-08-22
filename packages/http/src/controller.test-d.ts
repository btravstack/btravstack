// The five compile gates the keyed router form exists to provide. Each
// `@ts-expect-error` is an assertion: if one stops erroring, the gate is gone.
import { authenticated } from "@btravstack/contract";
import { Provider } from "@btravstack/di";
import { oc, type as ocType } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { HttpController } from "./controller.js";
import { httpAuth } from "./http-auth.js";
import { HttpRouter, type Implementation } from "./orpc.js";

const contract = { orders: { place: oc }, users: { find: oc } };

const orders = HttpController(
  "GateOrders",
  contract.orders,
)({
  sync: () => ({ place: () => OkAsync("placed") }),
});
const users = HttpController(
  "GateUsers",
  contract.users,
)({
  sync: () => ({ find: () => OkAsync("found") }),
});

// 1. Every contract key must be covered.
// @ts-expect-error — `users` is missing from the record
void HttpRouter(contract)({ orders });

// 2. A key the contract does not declare is rejected.
// @ts-expect-error — `billing` is not in the contract
void HttpRouter(contract)({ orders, users, billing: orders });

// 3. A controller wired under the wrong key is rejected.
// @ts-expect-error — `users`'s fragment is not `orders`'s
void HttpRouter(contract)({ orders: users, users: orders });

// 4. A procedure the fragment does not declare is rejected inside the controller.
void HttpController(
  "GateTypo",
  contract.orders,
)({
  // @ts-expect-error — the fragment declares `place`, not `plce`
  sync: () => ({ plce: () => OkAsync("placed") }),
});

// 5. A slice lifts out into its own process with its controller UNCHANGED: a
//    fragment is a valid contract in its own right, and the lifted root takes
//    the very controller the modulith composed as its only dep and returns what
//    that controller built. Strictly stronger than re-implementing the fragment
//    with a fresh `sync`, which would prove nothing about the controller. The
//    spec marks this "do not break"; this is what would catch breaking it.
void HttpRouter(contract.orders)(
  { implementation: orders.port },
  { sync: ({ implementation }) => implementation },
);

// The correct composition and the ARM-ONLY form, over the same contract, both
// still compile. This pair is `HttpRouter`'s discrimination gate: it is the one
// helper in the family with three forms and two arguments' worth of arity, so
// these two one-argument calls are told apart by whether `sync` holds a
// function (orpc.ts). Break that and one of these two lines stops compiling.
const composed = HttpRouter(contract)({ orders, users });
void HttpRouter(contract)({
  sync: () => ({
    orders: { place: () => OkAsync("placed") },
    users: { find: () => OkAsync("f") },
  }),
});

// The composed provider must DECLARE its controllers as needs — if the
// exactness intersection on the keyed `build` overload (orpc.ts) ever
// pollutes the inferred `M`, this collapses to `never` and di stops ordering
// the controllers before the router, silently.
type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
type Expect<T extends true> = T;
type _ComposedNeedsAreDeclared = Expect<[NeedsOf<typeof composed>] extends [never] ? false : true>;

// All five again, against a contract whose `orders` fragment is MARKED. The
// marker is a phantom key on the fragment, so every gate above has to survive
// it — the fifth especially: a marked slice must still lift out of the composed
// router with its controller unchanged. The contract names no principal, so the
// controllers here come from `httpAuth<Identity>()`, which is what types one.
const markedContract = { orders: authenticated(contract.orders), users: contract.users };

const { HttpController: IdentityController, HttpRouter: IdentityRouter } = httpAuth<{
  readonly userId: string;
}>();

const markedOrders = IdentityController(
  "GateMarkedOrders",
  markedContract.orders,
)({
  sync: () => ({ place: (opts) => OkAsync(opts.context.principal.userId) }),
});
const markedUsers = IdentityController(
  "GateMarkedUsers",
  markedContract.users,
)({
  sync: () => ({ find: () => OkAsync("found") }),
});

// 1. Every contract key must be covered.
// @ts-expect-error — `users` is missing from the record
void IdentityRouter(markedContract)({ orders: markedOrders });

// 2. A key the contract does not declare is rejected.
void IdentityRouter(markedContract)({
  orders: markedOrders,
  users: markedUsers,
  // @ts-expect-error — `billing` is not in the contract
  billing: markedOrders,
});

// 3. A controller wired under the wrong key is rejected.
// @ts-expect-error — `users`'s fragment is not the marked `orders`'s
void IdentityRouter(markedContract)({ orders: markedUsers, users: markedOrders });

// 4. A procedure the fragment does not declare is rejected inside the controller.
void IdentityController(
  "GateMarkedTypo",
  markedContract.orders,
)({
  // @ts-expect-error — the fragment declares `place`, not `plce`
  sync: () => ({ plce: () => OkAsync("placed") }),
});

// 5. The do-not-break lift, for a marked fragment.
void IdentityRouter(markedContract.orders)(
  { implementation: markedOrders.port },
  { sync: ({ implementation }) => implementation },
);

// The correct composition still compiles. The other direction is what has to
// be refused: a controller whose handler READS a principal cannot be mounted
// under an unmarked contract key, where nothing would inject one. (The reverse
// — an unmarked controller under a marked key — is accepted, and correctly so:
// a handler that ignores `opts.context.principal` is contravariantly fine.)
void IdentityRouter(markedContract)({ orders: markedOrders, users: markedUsers });
// @ts-expect-error — `markedOrders` needs a principal the unmarked contract declares nowhere
void IdentityRouter(contract)({ orders: markedOrders, users: markedUsers });

// The inheritance half: a record's requirements are the default for every
// procedure beneath it, and a procedure's own REPLACE that default rather than
// adding to it. `Schemes` is the registry `defineHttp` infers; here it is
// written out so `Implementation` can be probed on its own.
type TwoSchemes = {
  readonly user: { readonly userId: string };
  readonly service: { readonly appId: string };
};

const grouped = authenticated({ user: [] })({
  place: oc.input(ocType<{ readonly id: string }>()).output(ocType<{ readonly id: string }>()),
  export: authenticated(
    { user: [] },
    { service: [] },
  )(oc.output(ocType<{ readonly csv: string }>())),
});

// A procedure under a marked record inherits that record's requirement.
type PlaceContext = Parameters<Implementation<typeof grouped, TwoSchemes>["place"]>[0]["context"];
expectTypeOf<PlaceContext["principal"]>().toEqualTypeOf<{ readonly userId: string }>();

// A procedure with its own mark replaces the default rather than adding to it.
type ExportContext = Parameters<Implementation<typeof grouped, TwoSchemes>["export"]>[0]["context"];
expectTypeOf<ExportContext["principal"]>().toEqualTypeOf<
  | { readonly scheme: "user"; readonly identity: { readonly userId: string } }
  | { readonly scheme: "service"; readonly identity: { readonly appId: string } }
>();
