import { authenticated } from "@btravstack/contract";
import { pageOf, pageRequestOf } from "@btravstack/contract/zod";
import { oc } from "@orpc/contract";
import { z } from "zod";

/**
 * What an order looks like on the wire. Not the entity — the transport speaks
 * its own shape, and the orders controller is where the two are converted.
 *
 * The `id` slot carries the domain's `"OrderId"` brand, asked only of the SERVER
 * — a caller's inputs stay bare strings. What it buys is that two same-shaped
 * refs stop being interchangeable: a customers ref in an orders slot shipped
 * twice in one day before the brands separated them.
 *
 * A SCHEMA, with the type inferred from it rather than declared beside it:
 * `type<T>()` is oRPC's "trust this without validating", and under it
 * `{ quantity: "abc" }` reached the use case typed `number`.
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
 * An **unauthenticated** input names its tenant, as an argument rather than a
 * header the transport reads: `@btravstack/http-server` has no tenancy concept and
 * should not grow one.
 *
 * `orders` is marked `authenticated` and therefore does NOT name it — its
 * handlers serve the tenant the caller's own identity establishes. The contrast
 * is the lesson.
 */
const tenanted = z.object({ tenantId: z.uuidv7() });
export type Tenanted = z.infer<typeof tenanted>;

/** What a customer looks like on the wire. */
const customerView = z.object({ id: z.uuidv7().brand("CustomerId"), name: z.string() });
export type CustomerView = z.infer<typeof customerView>;

/**
 * What the customers fragment's `NOT_FOUND` carries. The same SHAPE as
 * `orderRef`, but the `"CustomerId"` brand makes the two mutually unassignable —
 * so reusing `orderRef` here is a compile error at the controller.
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

  // The shape 80% of a real API has, and the one that decides whether a client
  // can be written at all.
  //
  // The page shape is the contract tier's, not this contract's:
  // `pageRequestOf` carries the bounded limit, the two opaque cursors and the
  // refusal of both at once, and `pageOf` carries the four pages that exist.
  // `minQuantity` is this listing's own, and rides through as a filter. The
  // cursor is the only part of the input that did not come from the caller's
  // own vocabulary, which is why `BAD_REQUEST` is declared here.
  //
  list: oc
    .input(pageRequestOf({ minQuantity: z.number().int().min(1).optional() }))
    .output(pageOf(orderView))
    .errors({ BAD_REQUEST: { data: z.object({ cursor: z.string() }) } }),

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
 * An error a procedure declares is INFERABLE, so oRPC returns it as a value and
 * the client sees it typed; anything not declared here collapses to
 * `INTERNAL_SERVER_ERROR`, which is what a `Defect` deserves. Each code is one
 * arm of the exhaustive `mapErrCases` in a slice's controller, so adding a
 * domain error without adding a code here stops that file compiling.
 *
 * `orders` is marked and `customers` is not, so a client reads which half needs
 * credentials off the contract itself. `orders.export` overrides that group
 * default for itself, exercising a per-procedure override, a scope and a second
 * scheme at once.
 *
 * **The contract says WHICH SCHEMES protect a route, and nothing about who the
 * caller is.** No principal type is named here, so enriching one is never a
 * contract change; `defineHttp({ authenticators })` says what each resolves to.
 */
export const contract = { orders: ordersContract, customers: customersContract };
