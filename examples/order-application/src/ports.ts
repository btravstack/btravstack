import { Port } from "@btravstack/di";
import type {
  DuplicateOrder,
  InvalidQuantity,
  Order,
  OrderNotFound,
  OutOfStock,
  ShippingUnavailable,
} from "@btravstack/example-order-domain";
import type { AsyncResult } from "unthrown";

/**
 * The port the infrastructure layer fills. It is declared here, not in the
 * adapter, because the use cases own the shape they need — the direction that
 * keeps the dependency arrow pointing inwards.
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
  readonly save: (order: Order) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (id: string) => AsyncResult<Order, OrderNotFound>;
  readonly remove: (id: string) => AsyncResult<void, OrderNotFound>;
}> {}

/**
 * One event awaiting broadcast — the envelope every subscriber reads.
 *
 * `kind` says what sort of thing changed, `subjectId` says which one, and
 * `payload` says what it now is. A **null payload is the tombstone**: the last
 * word about a subject, saying it is gone. That is the whole vocabulary a
 * reader needs to rebuild state — the first event for a subject creates it,
 * later ones with a payload replace it, and the null one deletes it — and it
 * is why `id`, the outbox sequence, is the order the relay must publish in.
 */
export type OrderEvent = {
  readonly id: number;
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
 */
export class Outbox extends Port("Outbox")<{
  readonly pending: (limit: number) => AsyncResult<readonly OrderEvent[], never>;
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

export class Logger extends Port("Logger")<{
  readonly info: (message: string) => void;
  readonly lines: () => readonly string[];
}> {}

export class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (
    id: string,
    quantity: number,
  ) => AsyncResult<Order, InvalidQuantity | DuplicateOrder>;
}> {}

export class FindOrder extends Port("FindOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
