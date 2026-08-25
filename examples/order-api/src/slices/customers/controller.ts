import { Cache } from "@btravstack/cache";
import { contract, type CustomerView } from "@btravstack/example-order-api-contract";
import { FindCustomer } from "@btravstack/example-order-application";
import { TenantId, type Customer } from "@btravstack/example-order-domain";
import { OkAsync, P } from "unthrown";

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
 * It also reads through a cache, and the two recoveries are the interesting
 * half: **an unreachable cache is a miss, and a failed write is nothing** — both
 * recovered here, because whether an outage degrades a request or fails it is
 * the application's decision, not the cache package's. A stored value comes back
 * `unknown`, so a hit claims `CustomerView` by cast at the boundary where it
 * re-enters this application's vocabulary.
 */
export const customersController = api.HttpController("CustomersController", contract.customers)(
  { find: FindCustomer, cache: Cache },
  {
    sync: ({ find, cache }) => ({
      find: ({ errors }, input) => {
        const key = keyFor(input.tenantId, input.id);
        return cache
          .get(key)
          .recoverErrCases((matcher) => matcher.with(P.tag("CacheUnavailable"), () => undefined))
          .flatMap((hit) =>
            hit === undefined
              ? find
                  .execute(TenantId(input.tenantId), input.id)
                  .map(view)
                  .flatTap((cached) =>
                    cache
                      .set(key, cached, { ttlMs: VIEW_TTL_MS })
                      .recoverErrCases((matcher) =>
                        matcher.with(P.tag("CacheUnavailable"), () => undefined),
                      ),
                  )
              : OkAsync(hit.value as CustomerView),
          )
          .mapErrCases((matcher) =>
            matcher.with(P.tag("CustomerNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          );
      },
    }),
  },
);
