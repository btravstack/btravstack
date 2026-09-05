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
import { Port } from "@btravstack/di";
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

class Tenant extends Port("PinSliceTenant")<{ readonly id: string }> {}

const left = AmqpHandler(pinContract, "left")({ inject: {}, sync: () => () => OkAsync(undefined) });
const right = AmqpHandler(
  pinContract,
  "right",
)({
  inject: {},
  sync: () => () => OkAsync(undefined),
});

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

// Negative: an array that misses a declared key is refused at the root. The
// refusal is as long as the array the caller wrote, so the diagnostic lands on
// its trailing element and names the marker AND the missing key — measured
// here, at one element: `["UNCOVERED HANDLERS — …", "right"]`.
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
const otherLeft = AmqpHandler(
  otherContract,
  "left",
)({ inject: {}, sync: () => () => OkAsync(undefined) });
// @ts-expect-error -- built for `otherContract`, whose `left` message differs
AmqpHandlers(pinContract)([otherLeft, right]);

// Positive: the two existing arms still resolve, unchanged.
AmqpHandlers(pinContract)({
  inject: {},
  value: { left: () => OkAsync(undefined), right: () => OkAsync(undefined) },
});

// Positive: a piece declaring `unit:` reads those ports off `context.unit`,
// typed by the record it declared — one kind, so no narrowing to apply; what a
// name resolves to is the port's own service.
const scoped = AmqpHandler(
  pinContract,
  "left",
)({
  inject: {},
  unit: { tenant: Tenant },
  sync:
    () =>
    ({ context }) => {
      const id: string = context.unit.tenant.id;
      void id;
      return OkAsync(undefined);
    },
});
void scoped.unit.tenant;

// Negative: a name the piece did not declare is not on the record at all, so
// reading it is TypeScript's own "property does not exist".
AmqpHandler(
  pinContract,
  "right",
)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => (helpers) => {
    // @ts-expect-error -- `user` is no name this piece declared on `unit`
    void helpers.context.unit.user;
    return OkAsync(undefined);
  },
});
