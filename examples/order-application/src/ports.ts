import { Port } from "@btravstack/di";
import type {
  DuplicateOrder,
  InvalidQuantity,
  Order,
  OrderNotFound,
} from "@btravstack/start-example-order-domain";
import type { AsyncResult } from "unthrown";

/**
 * The port the infrastructure layer fills. It is declared here, not in the
 * adapter, because the use cases own the shape they need — the direction that
 * keeps the dependency arrow pointing inwards.
 */
export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (order: Order) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (id: string) => AsyncResult<Order, OrderNotFound>;
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
