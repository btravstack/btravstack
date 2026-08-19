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
 * An **unauthenticated** input names its tenant, because this API serves
 * several from one database and "which tenant" is then part of what is being
 * asked. It is an argument, not a header the transport reads:
 * `@btravstack/http` has no tenancy concept and should not grow one — context
 * is the application's to own, and naming it in the contract is what makes it
 * the application's.
 *
 * `orders` is marked `authenticated` and therefore does **not** name it: its
 * handlers serve `Principal.tenantId`, so a caller does not get to name the
 * tenant it is served, and a field the handlers ignore would be a lie in the
 * contract. `customers` is unmarked and keeps it. The contrast is the lesson —
 * where a caller's identity establishes the tenant, the input has nothing to
 * say about it.
 */
export type Tenanted = { readonly tenantId: string };

/** What a customer looks like on the wire. */
export type CustomerView = { readonly id: string; readonly name: string };

/**
 * The **minimum** a caller's identity must carry for this API's own semantics
 * to work — not everything the server knows about them. Named in the contract
 * because that is what makes a protected route legible to a client:
 * `authenticated` is one word in the shared artifact, visible in a diff and in
 * the generated types.
 *
 * `tenantId` is here because the marked fragment's inputs therefore do not
 * carry one: for a protected procedure the caller's identity is what
 * establishes the tenant. Nothing else is, on purpose.
 *
 * **The rule this file exists to demonstrate: declare the minimum here, and
 * let the authenticator resolve more.** The starter's gate is
 * `Auth extends { principal: Principal }`, so a *subtype* discharges it —
 * `bearerAuthenticator` resolves `{ tenantId, userId }` and satisfies a
 * contract asking only for `{ tenantId }`. Enriching what a deployment knows
 * about its callers — roles, an org tier, an internal id — is therefore NOT a
 * contract change, and none of it reaches a client.
 *
 * The limit worth knowing: a handler sees this type, not the authenticator's
 * richer one. A field a handler needs must be declared here, and is then
 * client-visible. That is the price of the field, and the reason to keep this
 * type as small as the API's semantics allow.
 */
export type Principal = { readonly tenantId: string };

const { authenticated } = auth<Principal>();

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
