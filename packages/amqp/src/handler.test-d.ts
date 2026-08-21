/**
 * The composing form's gates, all compile-time. A piece is typed by the ONE
 * contract key it names, so a drifted handler fails inside the slice; and the
 * root's array must cover every key the contract declares.
 */
import {
  defineContract,
  defineEventConsumer,
  defineEventPublisher,
  defineExchange,
  defineMessage,
  defineQueue,
} from "@amqp-contract/contract";
import { Env } from "@btravstack/config";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { AmqpModule } from "./amqp-module.js";
import { AmqpHandlers } from "./amqp-runtime.js";
import { AmqpHandler, type HandlerPortOf } from "./handler.js";

const pinExchange = defineExchange("pin-slice-exchange");
const leftQueue = defineQueue("pin-slice-left");
const rightQueue = defineQueue("pin-slice-right");
const pinMessage = defineMessage(z.object({ value: z.string() }));
const pinPublished = defineEventPublisher(pinExchange, pinMessage, { routingKey: "pin.sliced" });

const pinContract = defineContract({
  publishers: { echo: pinPublished },
  consumers: {
    left: defineEventConsumer(pinPublished, leftQueue),
    right: defineEventConsumer(pinPublished, rightQueue),
  },
});

const left = AmqpHandler(pinContract, "left")({ value: () => OkAsync(undefined) });
const right = AmqpHandler(pinContract, "right")({ value: () => OkAsync(undefined) });

// Positive: the piece carries the port it was minted under, typed for its key.
const _leftPort: HandlerPortOf<typeof pinContract, "left"> = left.port;

// Positive: an array covering every declared key composes, and the composed
// provider is the one `AmqpModule` takes.
const composed = AmqpHandlers(pinContract)([left, right]);
// The pieces are provided too: composing them into one provider makes the
// composed provider depend on their PORTS, which a root that names no slice
// still owes — the `needs` gate says so at this call.
AmqpModule("Pin")({
  contract: pinContract,
  handlers: composed,
  provides: [left, right],
  needs: [Env],
});

// Negative: a key the contract does not declare is refused at the piece's own
// call — there is nothing for it to be typed by.
// @ts-expect-error -- "middle" is not one of `pinContract`'s consumer/RPC names
AmqpHandler(pinContract, "middle");

// Negative: an array that misses a declared key is refused at the root. This
// array is one element long, so the diagnostic reports the marker alone — the
// missing key is named only once the array is as long as the marker tuple (2).
// @ts-expect-error -- the `right` consumer is uncovered
AmqpHandlers(pinContract)([left]);

// Negative: a piece built for ANOTHER contract is refused — the port's service
// is that contract's handler for that key, so the check is structural. Its own
// message, not `pinContract`'s — di's port typing is structural on id and
// service, so reusing `pinPublished` here would make the two `left` handlers
// the same type and this assertion would report nothing to catch.
const otherMessage = defineMessage(z.object({ value: z.number() }));
const otherPublished = defineEventPublisher(pinExchange, otherMessage, { routingKey: "pin.other" });
const otherContract = defineContract({
  publishers: { echo: otherPublished },
  consumers: { left: defineEventConsumer(otherPublished, leftQueue) },
});
const otherLeft = AmqpHandler(otherContract, "left")({ value: () => OkAsync(undefined) });
// @ts-expect-error -- built for `otherContract`, whose `left` message differs
AmqpHandlers(pinContract)([otherLeft, right]);

// Positive: the two existing arms still resolve, unchanged.
AmqpHandlers(pinContract)({
  value: { left: () => OkAsync(undefined), right: () => OkAsync(undefined) },
});
