/**
 * The gate the tenant's move into the unit exists for. A port that named its
 * tenant positionally, next to a string that is not one — `find(tenantId, id)`
 * — put a pair the compiler had little to say about at every call; the brand
 * closed half of that, and having no such parameter at all closes the rest.
 * The negatives below are what states it: there is no argument to get wrong.
 * Type-checked by this package's `test:types` script, never executed.
 */
import type { ServiceOf } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";

import type { OrderRepository, PlaceOrder } from "./index.js";

declare const repository: ServiceOf<OrderRepository>;
declare const placeOrder: ServiceOf<PlaceOrder>;

const tenant = TenantId("0199a1e0-0000-7000-8000-0000000000aa");
const orderId = "0199a1e0-0000-7000-8000-000000000001";

// Positive: the id this caller is asking about, and nothing else — the tenant
// is the unit's, provided once by whoever opened it.
const _found = repository.find(orderId);
const _placed = placeOrder.execute(orderId, 1);

// Negative: the tenant handed over at the call. It is one argument too many,
// and the brand also puts it in a position no parameter accepts.
// @ts-expect-error — the tenant is the unit's, not an argument
const _tenantFind = repository.find(tenant, orderId);

// @ts-expect-error — the tenant is the unit's, not an argument
const _tenantPlace = placeOrder.execute(tenant, orderId, 1);
