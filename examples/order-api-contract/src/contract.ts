import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

/**
 * What an order looks like on the wire. Not the entity — the transport speaks
 * its own shape, and the orders slice's controller is the one place the two
 * are converted. The `id` slot carries the domain's `"OrderId"` brand
 * (issue #80): a brand is a compile-time fiction that does not survive
 * serialization, and the fiction is asked only of the SERVER — the
 * construction side, where `error.id` and `order.id` already carry it — never
 * of a caller, whose inputs stay bare strings. What it buys is that two
 * same-shaped refs stop being interchangeable: a customers ref in an orders
 * slot was shipped twice in one day (#76, #77) before the brands separated
 * them.
 *
 * A **schema**, with the type inferred from it rather than declared beside it.
 * `type<T>()` — what this contract used before — is oRPC's escape hatch for
 * "trust this without validating", so every procedure accepted whatever a
 * client sent and `{ quantity: "abc" }` reached the use case typed `number`.
 * One definition means the checked shape and the compiled shape cannot drift,
 * which is what `order-temporal-contract` and `order-amqp-contract` already do.
 */
const orderView = z.object({ id: z.uuidv7().brand("OrderId"), quantity: z.number() });
export type OrderView = z.infer<typeof orderView>;

/** The payload every declared error carries — which order it was about. */
const orderRef = z.object({ id: z.uuidv7().brand("OrderId") });
export type OrderRef = z.infer<typeof orderRef>;

/**
 * What `BAD_REQUEST` carries, and the one ref whose `id` is a bare `string`.
 * It names the id **as received**, which is precisely the value that is not a
 * UUIDv7 — validating it against `z.uuidv7()` would reject the only payload
 * this error is ever constructed with.
 */
const malformedRef = z.object({ id: z.string() });

/**
 * An **unauthenticated** input names its tenant, because this API serves
 * several from one database and "which tenant" is then part of what is being
 * asked. It is an argument, not a header the transport reads:
 * `@btravstack/http-server` has no tenancy concept and should not grow one — context
 * is the application's to own, and naming it in the contract is what makes it
 * the application's.
 *
 * `orders` is marked `authenticated` and therefore does **not** name it: its
 * handlers serve the tenant the caller's own identity establishes, so a caller
 * does not get to name the tenant it is served, and a field the handlers ignore
 * would be a lie in the contract. `customers` is unmarked and keeps it. The
 * contrast is the lesson — where a caller's identity establishes the tenant,
 * the input has nothing to say about it.
 */
const tenanted = z.object({ tenantId: z.uuidv7() });
export type Tenanted = z.infer<typeof tenanted>;

/** What a customer looks like on the wire. */
const customerView = z.object({ id: z.uuidv7().brand("CustomerId"), name: z.string() });
export type CustomerView = z.infer<typeof customerView>;

/**
 * What the customers fragment's `NOT_FOUND` carries. The same *shape* as
 * `orderRef` and no longer merely a different schema by discipline: the
 * `"CustomerId"` brand makes the two refs mutually unassignable, so reusing
 * `orderRef` here — the defect #76 shipped and #77 copied — is a compile
 * error at the controller now, not a lie a reader has to catch.
 */
const customerRef = z.object({ id: z.uuidv7().brand("CustomerId") });
export type CustomerRef = z.infer<typeof customerRef>;

/** The orders slice's own fragment — a contract in its own right, so the slice can be served alone. */
const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(orderView)
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: malformedRef },
      CONFLICT: { data: orderRef },
    }),
  find: oc
    .input(orderRef)
    .output(orderView)
    .errors({ NOT_FOUND: { data: orderRef } }),

  // Overrides the group default for itself: a service token may export too,
  // and a user token needs the scope.
  export: authenticated(
    { user: ["orders:export"] },
    { service: [] },
  )(oc.output(z.object({ csv: z.string() }))),
});

/** The customers slice's own fragment. Reached as `contract.customers`; a fragment is a contract in its own right, so the slice can be served alone. */
const customersContract = {
  find: oc
    .input(tenanted.extend({ id: z.uuidv7() }))
    .output(customerView)
    .errors({ NOT_FOUND: { data: customerRef } }),
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
 * `orders` is `authenticated({ user: [] })(...)`, `customers` is not: the
 * marker is a type-level fact about the fragment, so a client reads which
 * half of this API needs credentials off the contract itself, and a server
 * that serves the marked half without an authenticator does not compile.
 * `orders.export` overrides that group default for itself — a user token
 * needs the `orders:export` scope, or a `service` token needs none — which is
 * how the marker exercises a per-procedure override, a scope and a second
 * scheme all at once.
 *
 * **The contract says WHICH SCHEMES protect a route, and nothing about who the
 * caller is.** No principal type is named here, so nothing about what this
 * deployment knows about a caller — a user id, roles, an org tier — reaches a
 * client, and enriching it is never a contract change. What each scheme
 * resolves to is `examples/order-api`'s `defineHttp({ authenticators })` to
 * say.
 */
export const contract = { orders: ordersContract, customers: customersContract };
