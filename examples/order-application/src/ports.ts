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
} from "@btravstack/example-order-domain";
import type { AsyncResult } from "unthrown";

/**
 * The port the infrastructure layer fills. It is declared here, not in the
 * adapter, because the use cases own the shape they need — the direction that
 * keeps the dependency arrow pointing inwards.
 *
 * **Every method names its tenant, and that is the application's design
 * rather than the framework's.** This deployment serves several tenants from
 * one database, so "which tenant" is part of what a repository is being asked
 * — not something read from an ambient store, and not something the kernel or
 * a starter knows about. Making it a parameter is what keeps it visible: a
 * use case that forgot to pass one does not compile, and a test needs no
 * machinery to set one.
 *
 * Both write paths promise more than a row: `save` also leaves an event in
 * the outbox and `remove` leaves a **tombstone**, each atomically — the write
 * and the fact of the write commit or roll back together, so a subscriber can
 * never miss either. `remove` is the compensation arm the fulfillment saga
 * leans on; deleting what does not exist is `OrderNotFound`, a value, so a
 * duplicate compensation is inert rather than a crash (and writes no second
 * tombstone).
 */
export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (tenantId: string, order: Order) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (tenantId: string, id: string) => AsyncResult<Order, OrderNotFound>;
  readonly remove: (tenantId: string, id: string) => AsyncResult<void, OrderNotFound>;
}> {}

/**
 * The customers slice's own port, declared here for the same reason
 * `OrderRepository` is: the use case owns the shape it needs, and it needs the
 * **entity** — never `CustomerView`, which is the transport's shape and would
 * point the dependency arrow outwards. Read-only, because nothing in this
 * application registers a customer yet; a write path is a method to add, not a
 * layer to redesign.
 */
export class CustomerRepository extends Port("CustomerRepository")<{
  readonly find: (tenantId: string, id: string) => AsyncResult<Customer, CustomerNotFound>;
}> {}

/**
 * One event awaiting broadcast — the envelope every subscriber reads.
 *
 * `tenantId` says whose it is, `kind` says what sort of thing changed,
 * `subjectId` says which one, and `payload` says what it now is. The tenant
 * travels ON the envelope rather than being read from an ambient record,
 * because the relay that reads this port sweeps across tenants from outside
 * any unit — it is the one place in the application that is deliberately not
 * tenant-scoped, and the event is what carries the tenant to the subscriber. A **null payload is the tombstone**: the last
 * word about a subject, saying it is gone. That is the whole vocabulary a
 * reader needs to rebuild state — the first event for a subject creates it,
 * later ones with a payload replace it, and the null one deletes it — and it
 * is why `id`, the outbox sequence, is the order the relay must publish in.
 */
export type OrderEvent = {
  readonly id: number;
  readonly tenantId: string;
  readonly kind: "order";
  readonly subjectId: string;
  readonly occurredAt: Date;
  readonly payload: { readonly quantity: number } | null;
};

/**
 * The read side of the transactional outbox. The write side has no port at
 * all — it *is* `OrderRepository.save`, which appends the event in the same
 * transaction as the row. This port exists for whichever deployment relays the
 * outbox onto a broker: pull what is pending, publish it, mark it sent. Both
 * operations are infallible in the application's terms — a database that will
 * not answer is a defect, not a domain outcome.
 *
 * `pending` names its tenant like every other read here. The relay that calls
 * it is the one caller with no request, delivery or activity behind it — it is
 * a background sweep on its own clock — so "which tenants does this relay
 * serve" is genuine deployment configuration (`OUTBOX_TENANTS`) rather than
 * something to infer. `markPublished` needs no tenant: an outbox id already
 * names one row.
 */
export class Outbox extends Port("Outbox")<{
  readonly pending: (tenantId: string, limit: number) => AsyncResult<readonly OrderEvent[], never>;
  readonly markPublished: (ids: readonly number[]) => AsyncResult<void, never>;
}> {}

/**
 * The two fulfillment ports the saga orchestrates around placement. In a real
 * system they are other services reached over a wire; the deployment that
 * needs them provides the adapter. `reserve` and `arrange` answer with the
 * domain's own permanent failures; `release` is compensation and compensation
 * must not invent new ways to fail.
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
 * implements. `PaymentDeclined` is a permanent no — the card was refused, and
 * asking again changes nothing — which is why the contract marks it
 * `nonRetryable`; anything else that goes wrong is infrastructure and stays
 * unmodelled, so the platform retries it. `PaymentDeclined` itself lives in
 * `order-domain`, not here — the same reason `OutOfStock` and
 * `ShippingUnavailable` do: it is a domain answer a caller is entitled to
 * branch on, whatever adapter happens to produce it.
 */
export class PaymentService extends Port("PaymentService")<{
  readonly authorize: (orderId: string, amount: number) => AsyncResult<string, PaymentDeclined>;
  readonly capture: (authorizationId: string) => AsyncResult<void, never>;
  readonly refund: (authorizationId: string) => AsyncResult<void, never>;
}> {}

export class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (
    tenantId: string,
    id: string,
    quantity: number,
  ) => AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder>;
}> {}

export class FindOrder extends Port("FindOrder")<{
  readonly execute: (tenantId: string, id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

export class FindCustomer extends Port("FindCustomer")<{
  readonly execute: (tenantId: string, id: string) => AsyncResult<Customer, CustomerNotFound>;
}> {}
