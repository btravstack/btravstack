import type { Page, PageRequest } from "@btravstack/contract";
import { Port } from "@btravstack/di";
import type {
  Customer,
  CustomerNotFound,
  DuplicateOrder,
  InvalidOrderId,
  InvalidQuantity,
  Order,
  OrderNotFound,
  OutOfStock,
  PaymentDeclined,
  ShippingUnavailable,
  TenantId,
} from "@btravstack/example-order-domain";
import type { AsyncResult } from "unthrown";

import type { MalformedCursor } from "./pagination.js";

/**
 * The port the infrastructure layer fills, declared here rather than in the
 * adapter because the use cases own the shape they need.
 *
 * **Every method names its tenant, and that is the application's design rather
 * than the framework's.** Making it a parameter is what keeps it visible: a use
 * case that forgot to pass one does not compile, and a test needs no machinery
 * to set one.
 *
 * Both write paths promise more than a row: `save` also leaves an event in the
 * outbox and `remove` leaves a **tombstone**, each atomically, so a subscriber
 * can never miss either. Deleting what does not exist is `OrderNotFound`, a
 * value, so a duplicate compensation is inert.
 */
export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (tenantId: TenantId, order: Order) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (tenantId: TenantId, id: string) => AsyncResult<Order, OrderNotFound>;
  readonly list: (
    tenantId: TenantId,
    query: OrderQuery,
  ) => AsyncResult<Page<Order>, MalformedCursor>;
  readonly remove: (tenantId: TenantId, id: string) => AsyncResult<void, OrderNotFound>;
}> {}

/**
 * A page of orders, plus the one filter this listing supports.
 *
 * The filter is a FIELD rather than a free-form predicate: a port that took a
 * query object would be asking the application layer to speak the adapter's
 * query language, and every store would then have to answer it.
 */
export type OrderQuery = PageRequest & { readonly minQuantity?: number | undefined };

/**
 * The customers slice's own port. It needs the **entity** — never
 * `CustomerView`, which is the transport's shape and would point the dependency
 * arrow outwards. Read-only, because nothing here registers a customer yet.
 */
export class CustomerRepository extends Port("CustomerRepository")<{
  readonly find: (tenantId: TenantId, id: string) => AsyncResult<Customer, CustomerNotFound>;
}> {}

/**
 * One event awaiting broadcast — the envelope every subscriber reads.
 *
 * The tenant travels ON the envelope rather than being read from an ambient
 * record, because the relay sweeps across tenants from outside any unit. A
 * **null payload is the tombstone**: the last word about a subject. That is the
 * whole vocabulary a reader needs to rebuild state, and it is why `id`, the
 * outbox sequence, is the order the relay must publish in.
 */
export type OrderEvent = {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly kind: "order";
  readonly subjectId: string;
  readonly occurredAt: Date;
  readonly payload: { readonly quantity: number } | null;
};

/**
 * The read side of the transactional outbox. The write side has no port at all —
 * it IS `OrderRepository.save`, which appends the event in the same transaction
 * as the row. Both operations are infallible in the application's terms: a
 * database that will not answer is a defect, not a domain outcome.
 *
 * `pending` names its tenant like every other read here; the relay that calls it
 * has no request behind it, so which tenants it serves is deployment
 * configuration. `markPublished` needs none — an outbox id already names one row.
 */
export class Outbox extends Port("Outbox")<{
  readonly pending: (
    tenantId: TenantId,
    limit: number,
  ) => AsyncResult<readonly OrderEvent[], never>;
  readonly markPublished: (ids: readonly number[]) => AsyncResult<void, never>;
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

export class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (
    tenantId: TenantId,
    id: string,
    quantity: number,
  ) => AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder>;
}> {}

export class FindOrder extends Port("FindOrder")<{
  readonly execute: (tenantId: TenantId, id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

export class ListOrders extends Port("ListOrders")<{
  readonly execute: (
    tenantId: TenantId,
    query: OrderQuery,
  ) => AsyncResult<Page<Order>, MalformedCursor>;
}> {}

export class FindCustomer extends Port("FindCustomer")<{
  readonly execute: (tenantId: TenantId, id: string) => AsyncResult<Customer, CustomerNotFound>;
}> {}
