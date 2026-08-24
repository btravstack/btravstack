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
 * The key carries the tenant, because the port does not.
 *
 * `Cache` is an application service and takes plain string keys — the
 * framework has no concept of a tenant anywhere — so composing one is the
 * application's job, and getting it wrong here would serve one tenant's
 * customer to another. It is the same discipline `find(tenantId, id)` states
 * in the type, spelled by hand where the type cannot.
 */
const keyFor = (tenantId: string, id: string): string => `customers:${tenantId}:${id}`;

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
 * It also reads through a cache, and the two recoveries are the interesting
 * half. **An unreachable cache is a miss, and a failed write is nothing** —
 * both recovered right here, because whether a cache outage degrades a
 * request or fails it is the application's decision and not the cache
 * package's. The stored value comes back `unknown`, so a hit claims
 * `CustomerView` by cast: the same once-per-boundary rule a branded id
 * follows, at the boundary where a stored value re-enters this application's
 * vocabulary.
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
