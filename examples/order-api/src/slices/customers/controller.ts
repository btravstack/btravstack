import { Cache } from "@btravstack/cache";
import { contract, type CustomerView } from "@btravstack/example-order-api-contract";
import { FindCustomer } from "@btravstack/example-order-application";
import { TenantId, type Customer } from "@btravstack/example-order-domain";
import { P } from "unthrown";

import { api } from "../../auth.js";

const view = (customer: Customer): CustomerView => ({ id: customer.id, name: customer.name });

/** A minute: long enough that a burst of reads costs one query, short enough that a rename is not stale for a shift. */
const VIEW_TTL_MS = 60_000;

/**
 * The key carries the tenant, because the port does not: `Cache` takes plain
 * string keys, so composing one is the application's job and getting it wrong
 * would serve one tenant's customer to another. The same discipline
 * `find(tenantId, id)` states in the type, spelled by hand where the type
 * cannot.
 */
const keyFor = (tenantId: string, id: string): string => `customers:${tenantId}:${id}`;

/**
 * The customers slice's transport boundary, over the same stack the orders one
 * uses, with `view` as the one place the branded `Customer` becomes the wire's
 * `CustomerView`. A slice is defined by owning its fragment, its controller and
 * its triage, not by owning a private adapter.
 *
 * It also reads through a cache, which is one `getOrSet` call: the degradation
 * policy — **an unreachable cache is a miss, and a failed write is nothing** —
 * is the port's, decided once, so what is left here is the key, the ttl and the
 * loader. Composing the key is still this application's job, tenant included.
 */
export const customersController = api.OrpcController(
  contract,
  "customers",
)({
  inject: { find: FindCustomer, cache: Cache },
  sync: ({ find, cache }) => ({
    find: ({ errors }, input) =>
      cache
        .getOrSet(
          keyFor(input.tenantId, input.id),
          () => find.execute(TenantId(input.tenantId), input.id).map(view),
          { ttlMs: VIEW_TTL_MS },
        )
        .mapErrCases((matcher) =>
          matcher.with(P.tag("CustomerNotFound"), (error) =>
            errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
          ),
        ),
  }),
});
