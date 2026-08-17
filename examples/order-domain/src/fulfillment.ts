import { TaggedError } from "unthrown";

/**
 * The three failures fulfillment can answer with beyond placement's own. They
 * live here — not in the application's ports file — for the same reason
 * `DuplicateOrder` does: they are domain answers a caller is entitled to
 * branch on, whatever adapter happens to produce them.
 */

/** The stock on hand cannot cover the order. A permanent answer for this order. */
export class OutOfStock extends TaggedError("OutOfStock")<{
  readonly id: string;
  readonly quantity: number;
}> {}

/** No carrier can take the shipment. Permanent for this order, too. */
export class ShippingUnavailable extends TaggedError("ShippingUnavailable")<{
  readonly id: string;
}> {}

/**
 * The card was refused. A permanent answer for this authorization attempt —
 * unlike an unmodelled infrastructure failure, asking the provider again
 * changes nothing.
 */
export class PaymentDeclined extends TaggedError("PaymentDeclined")<{
  readonly id: string;
}> {}
