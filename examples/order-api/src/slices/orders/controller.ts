import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { Logger } from "@btravstack/observability";
import { OkAsync, P } from "unthrown";

import { api } from "../../auth.js";

const view = (order: Order): OrderView => ({ id: order.id, quantity: order.quantity });

/**
 * The transport boundary, and the only place in this slice where a domain
 * error becomes something else.
 *
 * `HttpController(name, contract.orders)` is contract-first: the implementation
 * is a record shaped like the fragment whose leaves are plain `Result`-returning
 * functions, typed by the contract at the call — the input is the contract's
 * parsed input, the output its declared view, `errors` its declared error
 * map, and a typo'd or missing procedure is a compile error. `implement`,
 * `os.…`, `.result(...)` and `os.router(...)` are what the starter does with
 * it. In each handler, `Ok` is the output, an `Err` holding an `ORPCError` is
 * *returned* (so oRPC marks it inferable and the client gets it typed), and a
 * `Defect` rethrows its cause onto oRPC's own defect path, where it collapses
 * to `INTERNAL_SERVER_ERROR`. The `mapErrCases` in between is the triage
 * point: every case of the use case's error type is named, because the
 * matcher has no wildcard to fall back on. A new domain error is a compile
 * error here, at the one place that has to decide what the client sees.
 *
 * The tenant comes off `context.principal`, the value this application's own
 * authenticator resolved from the request's headers — `contract.orders` is
 * marked `authenticated({ user: [] })`, so the principal is typed here and a
 * handler that misreads it does not compile. `HttpController` is
 * `../../auth.ts`'s `api`, minted by `defineHttp({ authenticators })`, which is
 * why the principal has a readable type at all: the contract says only which
 * schemes protect the route, and that call is what says what each one
 * resolves to.
 *
 * `export` is where the two halves separate: it names a second scheme, so its
 * principal is a discriminated union the handler has to narrow, and the
 * compiler checks that every scheme the contract named is answered for. The
 * other two name one scheme and keep reading `context.principal.tenantId`
 * bare, which is the property the whole design rests on.
 *
 * Who placed an order is a transport-boundary fact, so it is logged
 * here rather than pushed through a use case that has no business with it. The fragment's inputs name **no** tenant: a
 * caller does not get to name the tenant it is served, and a required field
 * these handlers ignore would be a lie in the contract. The unmarked
 * `customers` fragment still names one, which is where that contrast is
 * legible. The starter knows nothing about tenancy either way — it resolved a
 * principal this application defined, and what the fields on it mean is the
 * application's business.
 *
 * The use cases arrive as arguments, not through oRPC's context: di injects
 * them into the provider — `HttpController(name, contract)` is di's own
 * `Provider(port)` on a port it mints for this controller, so this is a
 * provider like any other in the graph.
 */
export const ordersController = api.HttpController("OrdersController", contract.orders)(
  { place: PlaceOrder, find: FindOrder, logger: Logger },
  {
    sync: ({ place, find, logger }) => ({
      place: ({ errors, context }, input) => {
        logger.info("order placement requested", { userId: context.principal.userId });
        return place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
              )
              // `BAD_REQUEST`, not `CONFLICT`: a malformed id is the caller's
              // mistake, and 400 is the only status that says so. The arm costs
              // nothing — `mapErrCases` is exhaustive, so it is written or the
              // build fails — and it is not dead code elsewhere: `placeOrder` is
              // a public export whose own signature takes a bare `string`, so
              // this fragment's `z.uuidv7()` is one caller's guard rather than
              // the function's, and the documentation site's generic pages
              // declare `id: z.string()`, where the arm is live.
              //
              // Two paths reach the same code: this one, and oRPC's own
              // pre-dispatch refusal of an id the schema rejects. What tells
              // them apart is `inferable`, not the payload — oRPC's refusal
              // throws `ORPCError("BAD_REQUEST", { data: { issues } })`, so it
              // carries data too. `inferable` defaults to `false` and is set
              // only when a handler *returns* an `ORPCError` as its output, and
              // `isInferableError` is `e instanceof ORPCError && e.inferable`,
              // which is why `@unthrown/orpc` hands one back on the error
              // channel and the other on the defect channel. `api.spec.ts` pins
              // both halves, `inferable: true` here and `inferable: false`
              // there — a structural mechanism, not a coincidence.
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.BAD_REQUEST({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({ message: error.message, data: { id: error.id } }),
              ),
          );
      },
      find: ({ errors, context }, input) =>
        find
          .execute(context.principal.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
      // A stand-in body: what this procedure is here for is the principal. A
      // missing arm leaves a path returning nothing, which the handler's own
      // return type refuses — so the switch is exhaustive or the build fails.
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            logger.info("order export requested", { userId: context.principal.identity.userId });
            return OkAsync({ csv: "" });
          case "service":
            logger.info("order export requested", { appId: context.principal.identity.appId });
            return OkAsync({ csv: "" });
        }
      },
    }),
  },
);
