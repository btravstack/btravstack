import { auth } from "@btravstack/contract";
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

/**
 * Every input names its tenant, because this API serves several from one
 * database and "which tenant" is part of what is being asked.
 *
 * It is an **argument**, not a header the transport reads: `@btravstack/http`
 * has no tenancy concept and should not grow one — context is the
 * application's to own. Naming it in the contract is what makes it the
 * application's: a client cannot forget it, the router cannot invent one, and
 * the use case it reaches takes it as a parameter all the way to the
 * repository. A deployment that later authenticates its callers would put the
 * tenant on the caller's identity instead and drop it from here; that is a
 * contract change, which is exactly the kind of change it should be.
 */
export type Tenanted = { readonly tenantId: string };

/** What a customer looks like on the wire. */
export type CustomerView = { readonly id: string; readonly name: string };

/**
 * Who the caller is, as this API models it. Named in the contract because that
 * is what makes a protected route legible to a client: `authenticated` is one
 * word in the shared artifact, visible in a diff and in the generated types.
 *
 * `tenantId` is on the principal AND on every input, deliberately: moving
 * tenancy onto the caller's identity is a separate contract change, and this
 * one is about the transport.
 */
export type Principal = { readonly userId: string; readonly tenantId: string };

const { authenticated } = auth<Principal>();

/** The orders slice's own fragment — a contract in its own right, so the slice can be served alone. */
const ordersContract = {
  place: oc
    .input(type<Tenanted & { readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  find: oc
    .input(type<Tenanted & OrderRef>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
};

/** The customers slice's own fragment. Reached as `contract.customers`; a fragment is a contract in its own right, so the slice can be served alone. */
const customersContract = {
  find: oc
    .input(type<Tenanted & { readonly id: string }>())
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
 *
 * `orders` is `authenticated(...)`, `customers` is not: the marker is a
 * type-level fact about the fragment, so a client reads which half of this API
 * needs credentials off the contract itself, and a server that serves the
 * marked half without an authenticator does not compile.
 */
export const contract = {
  orders: authenticated(ordersContract),
  customers: customersContract,
};
