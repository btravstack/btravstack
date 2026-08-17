import { oc, type } from "@orpc/contract";

/**
 * What an order looks like on the wire. Not the entity: `Order`'s fields are
 * branded (`OrderId`, `Quantity`), and a brand is a compile-time fiction that
 * does not survive serialization. The transport speaks its own shape, and
 * the orders slice's controller is the one place the two are converted.
 */
export type OrderView = { readonly id: string; readonly quantity: number };

/** The payload every declared error carries — which order it was about. */
export type OrderRef = { readonly id: string };

/** What a customer looks like on the wire. */
export type CustomerView = { readonly id: string; readonly name: string };

/** The orders slice's own fragment — a contract in its own right, so the slice can be served alone. */
const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  find: oc
    .input(type<OrderRef>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
};

/** The customers slice's own fragment. Reached as `contract.customers`; a fragment is a contract in its own right, so the slice can be served alone. */
const customersContract = {
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<CustomerView>())
    .errors({ NOT_FOUND: { data: type<{ readonly id: string }>() } }),
};

/**
 * The contract, declared before any implementation exists.
 *
 * The `.errors({...})` declarations are the transport half of the errors-as-values
 * story: an error a procedure declares is *inferable*, so oRPC returns it as a
 * value and the client sees it fully typed rather than as a thrown 500. Anything
 * NOT declared here collapses to `INTERNAL_SERVER_ERROR` — which is exactly the
 * treatment a `Defect` deserves, and the reason the two channels line up without
 * an adapter in between.
 *
 * Each code is one arm of the exhaustive `mapErrCases` in a slice's own
 * controller. Adding a domain error without adding a code here stops that
 * file compiling.
 */
export const contract = { orders: ordersContract, customers: customersContract };
