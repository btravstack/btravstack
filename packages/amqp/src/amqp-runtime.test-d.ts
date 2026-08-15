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
import { Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { AmqpModule } from "./amqp-module.js";
import { AmqpHandlers, amqp } from "./amqp-runtime.js";

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

// The same three, through the `AmqpModule` sugar: the check is made on the
// handlers PROVIDER's instance type, not the port class, and it is the same
// check. The positive is minted by `AmqpHandlers`, the sugar's own way to a
// handlers provider — its port's service IS `WorkerInferHandlers<typeof
// pinContract>`, so the check passes by construction, and its `.port` is the
// port `amqp()` accepts.
const pinHandlers = AmqpHandlers(pinContract)("Pin")({ value: { echo: () => OkAsync(undefined) } });
AmqpModule("Pin")({ contract: pinContract, handlers: pinHandlers });
amqp({ contract: pinContract, handlers: pinHandlers.port });

// Negative: `AmqpHandlers` will not build a provider that misses a consumer —
// the port's service is the contract's own record, so the arm is checked
// against it before any module sees it.
// @ts-expect-error -- the `echo` consumer has no handler
AmqpHandlers(pinContract)("Empty")({ value: {} });
AmqpModule("Typo")({
  contract: pinContract,
  // @ts-expect-error -- "ecoh" is not one of `pinContract`'s consumer/RPC names, and "echo" is missing
  handlers: Provider(TypoHandlers)({ value: { ecoh: () => undefined, anything: 1 } }),
});
AmqpModule("NoHandlers")({
  contract: pinContract,
  // @ts-expect-error -- the `echo` consumer has no handler
  handlers: Provider(NoHandlers)({ value: {} }),
});
