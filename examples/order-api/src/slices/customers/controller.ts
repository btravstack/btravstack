import { contract, type CustomerView } from "@btravstack/example-order-api-contract";
import { FindCustomer } from "@btravstack/example-order-application";
import { TenantId, type Customer } from "@btravstack/example-order-domain";
import { P } from "unthrown";

import { api } from "../../auth.js";

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
 *
 * There is no display name to give any more: `HttpController(contract,
 * "customers")` mints this piece's port from the contract key itself
 * (`HttpController:customers`), so the key rides the port id rather than a
 * string spelled here.
 */
export const customersController = api.HttpController(contract, "customers")(
  { find: FindCustomer },
  {
    sync: ({ find }) => ({
      find: ({ errors }, input) =>
        find
          .execute(TenantId(input.tenantId), input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("CustomerNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
    }),
  },
);
