// The five compile gates the keyed router form exists to provide. Each
// `@ts-expect-error` is an assertion: if one stops erroring, the gate is gone.
import { Provider } from "@btravstack/di";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";

import { HttpController } from "./controller.js";
import { HttpRouter } from "./orpc.js";

const contract = { orders: { place: oc }, users: { find: oc } };

const orders = HttpController("GateOrders", contract.orders)([], {
  sync: () => ({ place: () => OkAsync("placed") }),
});
const users = HttpController("GateUsers", contract.users)([], {
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
void HttpController("GateTypo", contract.orders)([], {
  // @ts-expect-error — the fragment declares `place`, not `plce`
  sync: () => ({ plce: () => OkAsync("placed") }),
});

// 5. A slice lifts out into its own process with its controller UNCHANGED: a
//    fragment is a valid contract in its own right, and the lifted root takes
//    the very controller the modulith composed as its only dep and returns what
//    that controller built. Strictly stronger than re-implementing the fragment
//    with a fresh `sync`, which would prove nothing about the controller. The
//    spec marks this "do not break"; this is what would catch breaking it.
void HttpRouter(contract.orders)([orders.port], { sync: (implementation) => implementation });

// The correct composition, and the positional form, both still compile.
const composed = HttpRouter(contract)({ orders, users });
void HttpRouter(contract)([], {
  sync: () => ({ orders: { place: () => OkAsync("placed") }, users: { find: () => OkAsync("f") } }),
});

// The composed provider must DECLARE its controllers as needs — if the
// exactness intersection on the keyed `build` overload (orpc.ts) ever
// pollutes the inferred `M`, this collapses to `never` and di stops ordering
// the controllers before the router, silently.
type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
type Expect<T extends true> = T;
type _ComposedNeedsAreDeclared = Expect<[NeedsOf<typeof composed>] extends [never] ? false : true>;
