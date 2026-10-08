import type { Page, PageRequest } from "@btravstack/contract";
import { Port } from "@btravstack/di";
import type {
  Customer,
  CustomerNotFound,
  DuplicateOrder,
  Order,
  OrderNotFound,
  OutOfStock,
  PaymentDeclined,
  ShippingUnavailable,
  TenantId,
} from "@btravstack/example-order-domain";
import type { AsyncResult } from "unthrown";

import type { CursorSortMismatch, MalformedCursor } from "./pagination.js";

/**
 * The tenant one unit of work is scoped to. A port rather than a parameter:
 * whoever opens the unit — an authenticated request, an activity attempt, a
 * delivery — provides it once, and everything built inside that unit is bound
 * to it.
 */
export class Tenant extends Port("Tenant")<TenantId> {}

/**
 * The port the infrastructure layer fills, declared here rather than in the
 * adapter because the use cases own the shape they need.
 *
 * No method names a tenant: the adapter is built inside a unit that already
 * has one, so a call cannot name somebody else's.
 *
 * Both write paths promise more than a row: `save` also leaves an event in the
 * outbox and `remove` leaves a **tombstone**, each atomically, so a subscriber
 * can never miss either. Deleting what does not exist is `OrderNotFound`, a
 * value, so a duplicate compensation is inert.
 *
 * `save`'s `operation` names the operation doing the saving. A second save of
 * an id under the SAME operation answers the order the first one stored, and
 * writes nothing — a retried attempt whose first try committed is recovering
 * its own write, not placing a duplicate. Under any other operation, or none,
 * it is still `DuplicateOrder`.
 *
 * `remove`'s `placedBefore` is a condition the STORE checks in the same
 * statement that deletes: a row placed at or after it is left alone, no
 * tombstone is written, and the answer is `OrderNotFound`. That is what lets
 * a sweep that listed an order delete only that order, and not one placed
 * under the same id since.
 */
export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (order: Order, operation?: string) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (id: string) => AsyncResult<Order, OrderNotFound>;
  readonly list: (
    query: OrderQuery,
  ) => AsyncResult<Page<Order>, MalformedCursor | CursorSortMismatch>;
  readonly remove: (
    id: string,
    condition?: { readonly placedBefore?: Date | undefined },
  ) => AsyncResult<void, OrderNotFound>;
}> {}

/**
 * A page of orders, sorted by quantity, plus the two filters this listing
 * supports: a quantity floor, and orders the STORE recorded as placed before
 * an instant — never an id's own timestamp, which is whatever its caller chose.
 *
 * Each filter is a FIELD rather than a free-form predicate: a port that took a
 * query object would be asking the application layer to speak the adapter's
 * query language, and every store would then have to answer it.
 */
export type OrderQuery = PageRequest<"quantity"> & {
  readonly minQuantity?: number | undefined;
  readonly placedBefore?: Date | undefined;
};

/**
 * The customers slice's own port. Its tenant stays a parameter: the unmarked
 * `customers` procedures open an anonymous unit, which has no principal to
 * take one from, so the caller names it on the input. It needs the **entity** — never
 * `CustomerView`, which is the transport's shape and would point the dependency
 * arrow outwards. Read-only, because nothing here registers a customer yet.
 */
export class CustomerRepository extends Port("CustomerRepository")<{
  readonly find: (tenantId: TenantId, id: string) => AsyncResult<Customer, CustomerNotFound>;
}> {}

/**
 * The two fulfillment ports the saga orchestrates around placement. `reserve`
 * and `arrange` answer with the domain's own permanent failures; `release` is
 * compensation, and compensation must not invent new ways to fail.
 */
export class StockService extends Port("StockService")<{
  readonly reserve: (orderId: string, quantity: number) => AsyncResult<void, OutOfStock>;
  readonly release: (orderId: string) => AsyncResult<void, never>;
}> {}

export class ShippingService extends Port("ShippingService")<{
  readonly arrange: (orderId: string) => AsyncResult<void, ShippingUnavailable>;
}> {}

/**
 * The payment provider, as a port the application owns and an adapter
 * implements. `PaymentDeclined` is a permanent no, which is why the contract
 * marks it `nonRetryable`; anything else is infrastructure and stays
 * unmodelled, so the platform retries it.
 */
export class PaymentService extends Port("PaymentService")<{
  readonly authorize: (
    orderId: string,
    amount: number,
    idempotencyKey: string,
  ) => AsyncResult<string, PaymentDeclined>;
  readonly capture: (authorizationId: string, idempotencyKey: string) => AsyncResult<void, never>;
  readonly refund: (authorizationId: string, idempotencyKey: string) => AsyncResult<void, never>;
}> {}
