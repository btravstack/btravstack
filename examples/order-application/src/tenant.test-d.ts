/**
 * The gate the brand exists for. Every port in this layer names its tenant
 * positionally, next to a string that is not one — `find(tenantId, id)`,
 * `execute(tenantId, id, quantity)` — and two `string`s in a fixed order are
 * precisely what the compiler has nothing to say about: swapping them
 * compiles, and the result is a query scoped to somebody else's rows.
 * `TenantId` gives one of the pair a nominal type, which is all it takes for
 * the pair to become unswappable. Type-checked by this package's `test:types`
 * script, never executed.
 */
import type { ServiceOf } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";

import type { OrderRepository, PlaceOrder } from "./index.js";

declare const repository: ServiceOf<OrderRepository>;
declare const placeOrder: ServiceOf<PlaceOrder>;

const tenant = TenantId("0199a1e0-0000-7000-8000-0000000000aa");
const orderId = "0199a1e0-0000-7000-8000-000000000001";

// Positive: the tenant this caller was handed, then the id it is asking about.
const _found = repository.find(tenant, orderId);
const _placed = placeOrder.execute(tenant, orderId, 1);

// Negative: the same two values, the other way round. A `TenantId` still
// passes where a plain `string` is asked for — the brand is only claimed in
// the position that names a tenant — so the id in first position is the one
// error, which is exactly the bug this file exists to catch.
// @ts-expect-error — an order id is not a TenantId
const _swappedFind = repository.find(orderId, tenant);

// @ts-expect-error — an order id is not a TenantId
const _swappedPlace = placeOrder.execute(orderId, tenant, 1);
