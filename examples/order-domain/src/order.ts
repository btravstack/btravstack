import { Entity } from "@btravstack/entity";
import { P, TaggedError, type Result } from "unthrown";
import { z } from "zod";

/**
 * The field vocabulary, branded so passing one where the other belongs is a
 * compile error. `OrderId` is a UUIDv7, which is what gives `placeOrder` a
 * second failure to name.
 */
export const OrderId = z.uuidv7().brand("OrderId");
/** The branded id, nameable as a type — what an error payload carries (issue #80). */
export type OrderId = z.infer<typeof OrderId>;
export const Quantity = z.number().int().brand("Quantity");

/**
 * The order, as an entity rather than a shape plus a constructor function.
 *
 * `id` is `immutable`, so `update` refuses it — an order's identity is settled
 * at placement. The quantity rule is an `Entity.invariant`: declared once and
 * re-checked on every path that produces one, where a hand-written guard covers
 * only the path it was written on.
 */
export class Order extends Entity("Order")(
  {
    id: Entity.field(OrderId, { immutable: true }),
    quantity: Quantity,
  },
  {
    invariants: [
      Entity.invariant(
        (d) => d.quantity > 0,
        (d) => `order ${d.id} asks for ${d.quantity} items, which is not a positive quantity`,
      ),
    ],
  },
) {}

/**
 * The one rule this layer owns: an order is for a positive number of items.
 * `id` is branded, because this only fires once the id PASSED the schema — a
 * malformed one is `InvalidOrderId`, checked first.
 */
export class InvalidQuantity extends TaggedError("InvalidQuantity")<{
  readonly id: OrderId;
  readonly quantity: number;
}> {
  override message = `order ${this.id} asks for ${this.quantity} items, which is not a positive quantity`;
}

/** The other rule a caller can break: an id that is not a UUIDv7. */
export class InvalidOrderId extends TaggedError("InvalidOrderId")<{
  readonly id: string;
}> {
  override message = `order id ${this.id} is not a UUIDv7`;
}

export class OrderNotFound extends TaggedError("OrderNotFound")<{
  readonly id: OrderId;
}> {
  override message = `no order with id ${this.id}`;
}

export class DuplicateOrder extends TaggedError("DuplicateOrder")<{
  readonly id: OrderId;
}> {
  override message = `order ${this.id} already exists`;
}

/**
 * Placement, in the layer's own vocabulary: `Order.make` returns
 * `Result<Order, InvalidEntity>`, and this names that structural failure in
 * terms the outer layers already speak.
 *
 * Two errors, discriminated on **which field** the entity named — never on the
 * message, which is prose rather than an API. A schema issue carries a `path`
 * and an invariant violation carries none, which is how the kinds tell
 * themselves apart. Three failure kinds map onto two errors: a fractional
 * quantity fails the schema and a non-positive one the invariant, and both are
 * the same thing to a caller.
 */
export const placeOrder = (
  id: string,
  quantity: number,
): Result<Order, InvalidQuantity | InvalidOrderId> =>
  Order.make({ id, quantity }).mapErrCases((matcher) =>
    matcher.with(P.tag("InvalidEntity"), (invalid) =>
      invalid.issues.some((issue) => Entity.keysOf(issue)[0] === "id")
        ? new InvalidOrderId({ id })
        : // The schema PASSED for `id`, so the claim is a cast, not a parse.
          new InvalidQuantity({ id: id as OrderId, quantity }),
    ),
  );
