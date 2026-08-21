import { Entity } from "@btravstack/entity";
import { P, TaggedError, type Result } from "unthrown";
import { z } from "zod";

/**
 * The field vocabulary. Both are branded, so an `OrderId` and a `Quantity` are
 * nominally distinct from the `string` and `number` they are made of — passing
 * one where the other belongs is a compile error rather than a bug.
 *
 * `OrderId` is a UUIDv7 — the shape every id in this example carries on the
 * wire and in the database. That format is what gives `placeOrder` a second
 * failure to name; see its TSDoc.
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

/** The other rule a caller can break: an id that is not a UUIDv7. */
export class InvalidOrderId extends TaggedError("InvalidOrderId")<{
  readonly id: string;
}> {
  override message = `order id ${this.id} is not a UUIDv7`;
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
 * this names that structural failure in terms the outer layers already speak.
 *
 * **This used to be one error, and the change is `OrderId`'s doing.** While
 * the id was an unconstrained string, the quantity was the only field a typed
 * caller could get wrong, so flattening `InvalidEntity` to `InvalidQuantity`
 * was total and the earlier decision was sound on its own terms. Giving
 * `OrderId` a UUIDv7 format added a second way to fail, and the flattening
 * became a mislabelling: `placeOrder("o-1", 2)` answered _"asks for 2 items,
 * which is not a positive quantity"_ about a quantity the caller got right.
 * So there are two errors now, discriminated on **which field** the entity
 * named.
 *
 * Which field, not which message — a message is prose, not an API. An issue
 * from the *schema* carries a `path`; an `Entity.invariant` violation carries
 * none, which is how the two kinds tell themselves apart. `Entity.keysOf`
 * reads that path as plain keys, because a Standard Schema path element may
 * be an object rather than a bare key. Note there are three failure kinds and
 * only two errors: a fractional quantity fails the schema *with* a path and a
 * non-positive one fails the invariant *without* one, and both are the same
 * thing to a caller.
 */
export const placeOrder = (
  id: string,
  quantity: number,
): Result<Order, InvalidQuantity | InvalidOrderId> =>
  Order.make({ id, quantity }).mapErrCases((matcher) =>
    matcher.with(P.tag("InvalidEntity"), (invalid) =>
      invalid.issues.some((issue) => Entity.keysOf(issue)[0] === "id")
        ? new InvalidOrderId({ id })
        : new InvalidQuantity({ id, quantity }),
    ),
  );
