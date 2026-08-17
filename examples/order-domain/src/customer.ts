import { Entity } from "@btravstack/entity";
import { TaggedError } from "unthrown";
import { z } from "zod";

/**
 * The field vocabulary, branded like the order's. Not a stylistic echo:
 * `@btravstack/entity` accepts nominal fields only, so a bare `z.string()`
 * name is a compile error at the field map rather than a convention held by
 * review.
 */
export const CustomerId = z.string().brand("CustomerId");
export const CustomerName = z.string().brand("CustomerName");

/**
 * The customer, as an entity rather than the wire shape under another name.
 *
 * `id` is `immutable`, so it is absent from `updateInput` — identity is
 * settled at registration. There is no `Entity.invariant` here because this
 * layer owns no rule about a name; what the entity still buys is the
 * separation the orders slice already teaches — a repository speaks branded
 * fields, and the transport converts to `CustomerView` at its controller.
 */
export class Customer extends Entity("Customer")({
  id: Entity.field(CustomerId, { immutable: true }),
  name: CustomerName,
}) {}

export class CustomerNotFound extends TaggedError("CustomerNotFound")<{
  readonly id: string;
}> {
  override message = `no customer with id ${this.id}`;
}
