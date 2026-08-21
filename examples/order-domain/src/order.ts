import { Entity } from "@btravstack/entity";
import { P, TaggedError, type Result } from "unthrown";
import { z } from "zod";

/**
 * The field vocabulary. Both are branded, so an `OrderId` and a `Quantity` are
 * nominally distinct from the `string` and `number` they are made of — passing
 * one where the other belongs is a compile error rather than a bug.
 *
 * `OrderId` is a UUIDv7 — the shape every id in this example carries on the
 * wire and in the database. `placeOrder`'s own TSDoc still describes an
 * unconstrained id; that drift is Task 4's to close.
 */
export const OrderId = z.uuidv7().brand("OrderId");
export const Quantity = z.number().int().brand("Quantity");

/**
 * The order, as an entity rather than a shape plus a constructor function.
 *
 * `id` is `immutable`, so it is absent from `updateInput` and `update` refuses
 * it — the identity of an order is settled at placement. The quantity rule is
 * an `Entity.invariant`: declared once on the entity, re-checked on every path
 * that produces one (`make`, a factory, `update`), and reported as a value.
 * The hand-written `quantity > 0 ? Ok(...) : Err(...)` it replaces guarded only
 * the one path it was written on.
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

/**
 * Placement, in the layer's own vocabulary. `Order.make` validates, runs the
 * invariants and constructs — returning `Result<Order, InvalidEntity>` — and
 * this names that structural failure `InvalidQuantity`, which is what the outer
 * layers already speak. The translation is total: with an unconstrained
 * `OrderId`, the quantity is the only field a typed caller can get wrong.
 */
export const placeOrder = (id: string, quantity: number): Result<Order, InvalidQuantity> =>
  Order.make({ id, quantity }).mapErrCases((matcher) =>
    matcher.with(P.tag("InvalidEntity"), () => new InvalidQuantity({ id, quantity })),
  );
