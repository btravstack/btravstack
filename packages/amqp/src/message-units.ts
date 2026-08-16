import { randomUUID } from "node:crypto";

import type { WorkerMiddleware } from "@amqp-contract/worker";
import type { RuntimeHost, UnitMeta } from "@btravstack/core";

/**
 * Open one kernel unit per delivery. It injects nothing: a handler is built by
 * di from the services it declares, and the ambient `currentUnit()` record is
 * what the unit leaves for the adapters that read it. `next()` unchanged is
 * the whole of the chain — the handler's own `Result` is what the worker
 * routes, and this package is transparent to it.
 *
 * **The kernel's per-unit `AbortSignal` rides that record too.** `host.run`
 * hands one to its work callback, and this middleware's callback is `next()`
 * — a handler has no parameter to receive it through, and this transport has
 * no cancellation story of its own to fall back on (an un-acked delivery is
 * redelivered, which is recovery, not cancellation). A handler that must stop
 * when the kernel stops waiting reads `currentUnit()?.signal`.
 */
export const messageUnits =
  (host: RuntimeHost<never>): WorkerMiddleware =>
  (args, next) =>
    host.run(metaFor(args.rawMessage), () => next());

/**
 * `UnitMeta.id` must be unique per unit, and a **delivery tag is not one**:
 * tags are per-channel and restart at `1` after a reconnect, which
 * amqp-connection-manager performs silently underneath this worker. The one
 * identifier that looks unique per delivery is not, across exactly the event
 * this library exists to handle. `consumerTag + deliveryTag` almost fixes it,
 * until `ConsumerOptions` lets a caller pin `consumerTag`. Minting is the only
 * form the rule survives — the same answer `-http` reaches per request.
 *
 * The publisher's `messageId` becomes the `traceId`: minted outside this
 * process and stable across every redelivery, which is what `traceId` is for.
 * `correlationId` is the fallback for an RPC-shaped message.
 *
 * Only a NON-BLANK id is adopted, and the trim is load-bearing rather than
 * tidy: `??` guards nullish alone, and `""` is not nullish, so a publisher
 * that sets `messageId: ""` — or a broker that hands one through — would give
 * every delivery the same blank trace id and defeat the ambient record
 * exactly as a category-as-id would. `-http` refuses a blank `x-request-id`
 * for the same reason.
 */
const metaFor = (raw: {
  readonly properties: {
    readonly messageId?: string | undefined;
    readonly correlationId?: string | undefined;
  };
}): UnitMeta => {
  const id = randomUUID();
  const inbound = [raw.properties.messageId, raw.properties.correlationId]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");

  return { kind: "delivery", id, traceId: inbound ?? id };
};
