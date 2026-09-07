import type { Order, OrderId } from "@btravstack/example-order-domain";
import { Err, Ok, TaggedError, type Result } from "unthrown";

import type { Caller } from "../../auth.js";

declare const AUTHORIZED: unique symbol;

/** An order the rule has admitted for export. Only `exportable` mints one. */
export type Authorized<T> = T & { readonly [AUTHORIZED]: true };

/** The refusal, in this application's own words rather than a status code. */
export class Forbidden extends TaggedError("Forbidden")<{
  readonly id: OrderId;
  readonly reason: string;
}> {
  override message = `order ${this.id} may not be exported: ${this.reason}`;
}

/** How many items an order may carry before exporting it stops being a user's operation. */
export const USER_EXPORT_CEILING = 1_000;

/** Layer 3: `(principal, resource) → decision`, decided where the resource is known. */
export const exportable = (caller: Caller, order: Order): Result<Authorized<Order>, Forbidden> =>
  caller.scheme === "service" || order.quantity <= USER_EXPORT_CEILING
    ? Ok(order as Authorized<Order>)
    : Err(new Forbidden({ id: order.id, reason: "bulk export is a service operation" }));

/** The operation the decision protects: there is no way to call it without one. */
export const renderCsv = (order: Authorized<Order>): string =>
  `id,quantity\n${order.id},${order.quantity}`;
