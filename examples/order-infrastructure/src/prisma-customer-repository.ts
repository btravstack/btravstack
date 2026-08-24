import { Provider, type ServiceOf } from "@btravstack/di";
import { CustomerRepository } from "@btravstack/example-order-application";
import { Customer, CustomerNotFound, type CustomerId } from "@btravstack/example-order-domain";
import { Err, P, type Result } from "unthrown";

import { OrderDatabase, type OrderDatabaseClient } from "./database.js";

type CustomerRow = { readonly customerId: string; readonly name: string };

/**
 * The same rebuild the orders adapter does, for the same reason: the row is
 * data, the entity is the thing with rules, and a row that cannot become one is
 * nobody's request — so it goes to the defect channel rather than widening `E`.
 * That is what lets `find` promise `CustomerNotFound` and nothing else.
 */
const hydrate = (row: CustomerRow): Result<Customer, never> =>
  Customer.make({ id: row.customerId, name: row.name }).mapErrCases((matcher, defect) =>
    matcher.with(P.tag("InvalidEntity"), (invalid) => defect(invalid)),
  );

/**
 * The customers vertical's outermost layer. It is read-only because the port
 * is: this application registers no customer, and inventing a write path the
 * use cases never call would be infrastructure the domain did not ask for.
 *
 * What it does share with `prismaOrderRepository` is the shape that matters —
 * a missing row is `CustomerNotFound`, the domain's own value, and the wire's
 * `CustomerView` is nowhere in sight. An adapter that returned the transport's
 * shape would point the dependency arrow outwards, which is precisely the wart
 * the throwaway in-memory directory this replaced had.
 */
export const prismaCustomerRepository = (
  db: OrderDatabaseClient,
): ServiceOf<CustomerRepository> => ({
  find: (tenantId, id) =>
    db.customer
      .tryFindUnique({ where: { tenantId_customerId: { tenantId, customerId: id } } })
      .flatMap((row) =>
        row === null ? Err(new CustomerNotFound({ id: id as CustomerId })) : hydrate(row),
      ),
});

export const customerRepositoryProvider = Provider(CustomerRepository)(
  { db: OrderDatabase },
  { sync: ({ db }) => prismaCustomerRepository(db) },
);
