import { contract, type CustomerView } from "@btravstack/example-order-api-contract";
import { FindCustomer } from "@btravstack/example-order-application";
import type { Customer } from "@btravstack/example-order-domain";
import { HttpController } from "@btravstack/http";
import { P } from "unthrown";

const view = (customer: Customer): CustomerView => ({ id: customer.id, name: customer.name });

/**
 * The customers slice's transport boundary — the orders controller's shape
 * over the orders controller's stack: a use case from
 * `@btravstack/example-order-application`, an entity from the domain, a
 * Prisma-backed repository behind it, and `view` as the one place the branded
 * `Customer` becomes the wire's `CustomerView`.
 *
 * That conversion is the point of the layering, not ceremony: the throwaway
 * directory this replaced declared its port over `CustomerView` itself, which
 * pointed the dependency arrow outwards — an adapter speaking the transport's
 * shape. A slice is defined by owning its fragment, its controller and its
 * triage, not by owning a private adapter.
 */
export const customersController = HttpController("CustomersController", contract.customers)(
  [FindCustomer],
  {
    sync: (find) => ({
      find: ({ errors }, input) =>
        find
          .execute(input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("CustomerNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
    }),
  },
);
