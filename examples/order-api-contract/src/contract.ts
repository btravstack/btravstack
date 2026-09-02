import { authenticated } from "@btravstack/contract";
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
  // `after` and `before` are OPAQUE strings — the cursors a previous page handed
  // back — so they are `z.string()` and nothing narrower: the server owns their
  // meaning, and a contract that described it would be publishing the adapter's
  // ordering. They are also the only parts of this input that did not come from
  // the caller's own vocabulary, which is why `BAD_REQUEST` is declared here and
  // names the offending one.
  //
  // **At most one of them**, refused by the SCHEMA rather than by the handler: a
  // page runs in one direction, and "after X and before Y" is a range query
  // wearing a page's clothes. The application's `PageRequest` makes the pair a
  // union, so the refusal and the type say the same thing at the two ends of the
  // wire — and the controller's one branch is where a validated input becomes
  // that union.
  //
  // Both cursors are nullable rather than optional: a client follows the one it
  // is paging by until it is `null`, and an absent field would make "no more
  // pages" and "the server forgot" the same value.
  list: oc
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
          after: z.string().optional(),
          before: z.string().optional(),
          minQuantity: z.number().int().min(1).optional(),
        })
        .refine(({ after, before }) => after === undefined || before === undefined, {
          message: "a page runs in one direction: pass `after` or `before`, not both",
        }),
    )
    .output(
      z.object({
        items: z.array(orderView),
        previousCursor: z.string().nullable(),
        nextCursor: z.string().nullable(),
        hasPreviousPage: z.boolean(),
        hasNextPage: z.boolean(),
      }),
    )
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
