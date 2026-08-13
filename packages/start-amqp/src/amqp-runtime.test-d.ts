/**
 * `AmqpOptions.handlers` is checked against the contract, not erased to
 * `Record<string, unknown>` — the whole point of parameterising `AmqpOptions`
 * on `TContract`. A typo'd key or a missing one used to typecheck clean and
 * fail only at runtime, on the first delivery, silently to the DLQ.
 *
 * Its own contract and port rather than `test-fixtures.js`'s: that module
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
import { Port } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { amqpRuntime } from "./amqp-runtime.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const pinExchange = defineExchange("pin-exchange");
const pinQueue = defineQueue("pin-queue");
const pinMessage = defineMessage(z.object({ value: z.string() }));
const pinPublished = defineEventPublisher(pinExchange, pinMessage, { routingKey: "pin.requested" });

const pinContract = defineContract({
  publishers: { echo: pinPublished },
  consumers: { echo: defineEventConsumer(pinPublished, pinQueue) },
});

// Positive: a handler for every consumer/rpc key the contract declares
// compiles as an ordinary call.
amqpRuntime({
  urls: ["amqp://localhost"],
  contract: pinContract,
  needs: [Greeting],
  handlers: () => ({ echo: () => OkAsync(undefined) }),
});

// Negative: a typo'd key does not compile. `WorkerInferHandlers` requires
// exactly the contract's own consumer/rpc names, so "ecoh" is neither the
// required `echo` entry nor a key the contract declares. Kept to one line —
// `@ts-expect-error` suppresses a diagnostic on the line immediately below
// it, and the mismatch is reported where the returned object literal is, not
// on the call's opening line.
amqpRuntime({
  urls: ["amqp://localhost"],
  contract: pinContract,
  needs: [Greeting],
  // @ts-expect-error -- "ecoh" is not one of `pinContract`'s consumer/RPC names, and "echo" is missing
  handlers: () => ({ ecoh: () => undefined, anything: 42 }),
});

// Negative: no handlers at all does not compile either — an empty record is
// missing the `echo` entry `WorkerInferHandlers<typeof pinContract, …>` requires.
amqpRuntime({
  urls: ["amqp://localhost"],
  contract: pinContract,
  needs: [Greeting],
  // @ts-expect-error -- the `echo` consumer has no handler
  handlers: () => ({}),
});
