/**
 * `AmqpOptions.handlers` is a PORT, and its service is checked against the
 * contract at the `amqp(...)` call — not erased to `Record<string, unknown>`.
 * A port whose service misses a consumer, or names one the contract does not
 * declare, fails to typecheck here rather than at the first delivery, silently
 * to the DLQ.
 *
 * Its own contract and ports rather than `test-fixtures.js`'s: that module
 * pulls in `@unthrown/vitest`'s matcher augmentation, which this file's own
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
import type { WorkerInferHandlers } from "@amqp-contract/worker";
import { Port } from "@btravstack/di";
import { z } from "zod";

import { amqp } from "./amqp-runtime.js";

const pinExchange = defineExchange("pin-exchange");
const pinQueue = defineQueue("pin-queue");
const pinMessage = defineMessage(z.object({ value: z.string() }));
const pinPublished = defineEventPublisher(pinExchange, pinMessage, { routingKey: "pin.requested" });

const pinContract = defineContract({
  publishers: { echo: pinPublished },
  consumers: { echo: defineEventConsumer(pinPublished, pinQueue) },
});

// Positive: a port whose service is a handler for every consumer/rpc key the
// contract declares compiles as an ordinary call.
class PinHandlers extends Port("PinHandlers")<WorkerInferHandlers<typeof pinContract>> {}
amqp({ contract: pinContract, handlers: PinHandlers });

// Negative: a typo'd key does not compile. `WorkerInferHandlers` requires
// exactly the contract's own consumer/rpc names, so "ecoh" is neither the
// required `echo` entry nor a key the contract declares.
class TypoHandlers extends Port("TypoHandlers")<{
  readonly ecoh: () => undefined;
  readonly anything: number;
}> {}
// @ts-expect-error -- "ecoh" is not one of `pinContract`'s consumer/RPC names, and "echo" is missing
amqp({ contract: pinContract, handlers: TypoHandlers });

// Negative: no handlers at all does not compile either — an empty record is
// missing the `echo` entry `WorkerInferHandlers<typeof pinContract>` requires.
class NoHandlers extends Port("NoHandlers")<Record<never, never>> {}
// @ts-expect-error -- the `echo` consumer has no handler
amqp({ contract: pinContract, handlers: NoHandlers });
