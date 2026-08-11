import { Err, Ok, TaggedError, type Result } from "unthrown";

export type Order = {
  readonly id: string;
  readonly quantity: number;
};

/** The one rule this layer owns: an order is for a positive number of items. */
export class InvalidQuantity extends TaggedError("InvalidQuantity")<{
  readonly id: string;
  readonly quantity: number;
}> {
  override message = `order ${this.id} asks for ${this.quantity} items, which is not a positive quantity`;
}

export class OrderNotFound extends TaggedError("OrderNotFound")<{
  readonly id: string;
}> {
  override message = `no order with id ${this.id}`;
}

export class DuplicateOrder extends TaggedError("DuplicateOrder")<{
  readonly id: string;
}> {
  override message = `order ${this.id} already exists`;
}

export const placeOrder = (id: string, quantity: number): Result<Order, InvalidQuantity> =>
  quantity > 0 ? Ok({ id, quantity }) : Err(new InvalidQuantity({ id, quantity }));
