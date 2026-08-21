/**
 * The handlers PORT is the starter's own, typed by the contract, and a
 * provider for it is checked against the contract at the `AmqpHandlers(...)`
 * call and again at `AmqpModule(...)` — not erased to `Record<string,
 * unknown>`. A record that misses a consumer, or names one the contract does
 * not declare, fails to typecheck there rather than at the first delivery,
 * silently to the DLQ; and a provider built for one contract cannot be handed
 * to a module declaring another.
 *
 * Its own contract rather than `test-fixtures.js`'s: that module pulls in
 * `@unthrown/vitest`'s matcher augmentation, which this file's own
 * `tsconfig.test-d.json` — `src/**\/*.test-d.ts` only — never loads.
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
import { start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { AmqpModule } from "./amqp-module.js";
import { AmqpHandlers, AmqpRuntime, amqp, type HandlersPortOf } from "./amqp-runtime.js";

const pinExchange = defineExchange("pin-exchange");
const pinQueue = defineQueue("pin-queue");
const pinMessage = defineMessage(z.object({ value: z.string() }));
const pinPublished = defineEventPublisher(pinExchange, pinMessage, { routingKey: "pin.requested" });

const pinContract = defineContract({
  publishers: { echo: pinPublished },
  consumers: { echo: defineEventConsumer(pinPublished, pinQueue) },
});

// Positive: `AmqpHandlers(contract)` is di's `Provider(port)` on the starter's
// handlers port typed for the contract, so a record with a handler for every
// consumer/rpc key the contract declares compiles as an ordinary call, and the
// provider satisfies both the sugar and the primitive.
const pinHandlers = AmqpHandlers(pinContract)({ value: { echo: () => OkAsync(undefined) } });
AmqpModule("Pin")({ contract: pinContract, handlers: pinHandlers, needs: [Env] });
Module("PinByHand")({
  needs: [Env],
  imports: [amqp({ contract: pinContract })],
  provides: [pinHandlers],
  exports: [AmqpRuntime],
});
const _pinPort: HandlersPortOf<typeof pinContract> = pinHandlers.port;

// Negative: `AmqpHandlers` will not build a provider that misses a consumer —
// the port's service is the contract's own record, so the arm is checked
// against it before any module sees it.
// @ts-expect-error -- the `echo` consumer has no handler
AmqpHandlers(pinContract)({ value: {} });

// Negative: a typo'd key does not compile. `WorkerInferHandlers` requires
// exactly the contract's own consumer/rpc names, so "ecoh" is neither the
// required `echo` entry nor a key the contract declares.
// @ts-expect-error -- "ecoh" is not one of `pinContract`'s consumer/RPC names, and "echo" is missing
AmqpHandlers(pinContract)({ value: { ecoh: () => undefined, anything: 1 } });

// Negative: a provider built for ANOTHER contract is refused by the module —
// the port's instance is typed per contract, so the check is structural on
// the handlers record, not on a name.
const otherContract = defineContract({
  publishers: { other: pinPublished },
  consumers: { other: defineEventConsumer(pinPublished, pinQueue) },
});
const otherHandlers = AmqpHandlers(otherContract)({ value: { other: () => OkAsync(undefined) } });
AmqpModule("Other")({
  contract: pinContract,
  // @ts-expect-error -- built for `otherContract`: its record has `other`, not `echo`
  handlers: otherHandlers,
});

// Negative: a hand-declared port of another id is not the starter's — the
// starter needs ITS port, so a root providing a different one still owes it.
// Since the `needs` gate that is refused HERE, at the module that owes it,
// rather than at `start`: the port is undeclared, and declaring it is not the
// escape either — the module would then have to be handed one.
class NoHandlers extends Port("NoHandlers")<Record<never, never>> {}
// @ts-expect-error -- UNDECLARED NEEDS: the starter's handlers port is still owed
const Unmet = Module("Unmet")({
  imports: [amqp({ contract: pinContract })],
  provides: [Provider(NoHandlers)({ value: {} })],
  exports: [AmqpRuntime],
});
// @ts-expect-error -- and `start` refuses it too, on the needs channel
start(Unmet, { signals: false, probes: false });
