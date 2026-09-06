/**
 * Two gates in one file, because the tenancy is spelled two ways here.
 *
 * The orders ports have no tenant parameter at all: it is the unit's,
 * provided once by whoever opened it, so there is no argument to get wrong.
 * The customers ports still take one, because an unmarked procedure opens an
 * anonymous unit with no principal to read a tenant from — and there the
 * BRAND is what keeps `(TenantId, string)` unswappable, since two `string`s
 * in a fixed order are what the compiler has nothing to say about.
 *
 * Type-checked by this package's `test:types` script, never executed.
 */
import type { ServiceOf } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";

import type { CustomerRepository, FindCustomer, OrderRepository, PlaceOrder } from "./index.js";

declare const repository: ServiceOf<OrderRepository>;
declare const placeOrder: ServiceOf<PlaceOrder>;
declare const customers: ServiceOf<CustomerRepository>;
declare const findCustomer: ServiceOf<FindCustomer>;

const tenant = TenantId("0199a1e0-0000-7000-8000-0000000000aa");
const orderId = "0199a1e0-0000-7000-8000-000000000001";
const customerId = "0199a1e0-0000-7000-8000-0000000000c1";

// Positive: the id this caller is asking about, and nothing else — the tenant
// is the unit's, provided once by whoever opened it.
const _found = repository.find(orderId);
const _placed = placeOrder.execute(orderId, 1);

// Negative: the tenant handed over at the call. It is one argument too many.
// @ts-expect-error — the tenant is the unit's, not an argument
const _tenantFind = repository.find(tenant, orderId);

// @ts-expect-error — the tenant is the unit's, not an argument
const _tenantPlace = placeOrder.execute(tenant, orderId, 1);

// Positive: the customers half, where the tenant IS a parameter — the tenant
// this caller was handed, then the id it is asking about.
const _customer = customers.find(tenant, customerId);
const _customerUseCase = findCustomer.execute(tenant, customerId);

// Negative: the same two values, the other way round. A `TenantId` still
// passes where a plain `string` is asked for — the brand is only claimed in
// the position that names a tenant — so the id in first position is the one
// error, which is exactly the bug the brand exists to catch. Drop
// `.brand("TenantId")` in `order-domain` and these two directives go unused.
// @ts-expect-error — a customer id is not a TenantId
const _swappedCustomer = customers.find(customerId, tenant);

// @ts-expect-error — a customer id is not a TenantId
const _swappedCustomerUseCase = findCustomer.execute(customerId, tenant);
