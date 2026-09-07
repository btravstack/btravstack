// The witness, pinned: `renderCsv` is reachable only through a decision, and
// the brand cannot be forged from outside `authorize.ts`.

import type { Order } from "@btravstack/example-order-domain";

import type { Caller } from "../../auth.js";
import { exportable, renderCsv, type Authorized } from "./authorize.js";
// Negative: the brand itself is not part of the surface, so nothing outside
// the module can name it — which is what makes the two refusals below
// unforgeable rather than merely inconvenient.
// @ts-expect-error TS2305 -- AUTHORIZED is declared, never exported
import type { AUTHORIZED } from "./authorize.js";

declare const caller: Caller;
declare const order: Order;

// Positive: what the rule admitted renders.
const _rendered: string = exportable(caller, order).map(renderCsv).getOr("");

// Positive: the witness carries the order through untouched.
declare const authorized: Authorized<Order>;
const _quantity: number = authorized.quantity;

// Negative: a plain order is not a decision.
// @ts-expect-error TS2345 -- Order is missing the unique symbol Authorized adds
renderCsv(order);

// Negative: the brand is a SPECIFIC symbol, so no other one stands in for it.
declare const branded: Order & { readonly [k: symbol]: true };
// @ts-expect-error TS2345 -- an index signature over symbol does not supply the declared one
renderCsv(branded);
