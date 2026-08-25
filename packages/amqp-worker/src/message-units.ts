import { randomUUID } from "node:crypto";

import type { WorkerMiddleware } from "@amqp-contract/worker";
import type { RuntimeHost, UnitMeta } from "@btravstack/core";

/**
 * Open one kernel unit per delivery. It injects nothing — `next()` unchanged is
 * the whole of the chain — so the ambient `currentUnit()` record is what the
 * unit leaves for the adapters that read it.
 *
 * **The kernel's per-unit `AbortSignal` rides that record too**, and it is the
 * only route to it here: a handler has no parameter to receive one through. A
 * handler that must stop when the kernel stops waiting reads
 * `currentUnit()?.signal`.
 */
export const messageUnits =
  (host: RuntimeHost<never>): WorkerMiddleware =>
  (args, next) =>
    host.run(metaFor(args.rawMessage), () => next());

/**
 * `UnitMeta.id` must be unique per unit, and a **delivery tag is not one**: tags
 * are per-channel and restart at `1` after a reconnect, which
 * amqp-connection-manager performs silently underneath this worker.
 * `consumerTag + deliveryTag` almost fixes it, until `ConsumerOptions` lets a
 * caller pin `consumerTag`. Minting is the only form the rule survives.
 *
 * A W3C `traceparent` header wins when the publisher sends one; otherwise
 * `messageId`, with `correlationId` as the RPC-shaped fallback.
 *
 * Only a NON-BLANK id is adopted, and the trim is load-bearing: `??` guards
 * nullish alone, so a publisher setting `messageId: ""` would give every
 * delivery the same blank trace id.
 */
const metaFor = (raw: {
  readonly properties: {
    readonly messageId?: string | undefined;
    readonly correlationId?: string | undefined;
    readonly headers?: Readonly<Record<string, unknown>> | undefined;
  };
}): UnitMeta => {
  const id = randomUUID();
  const parent = raw.properties.headers?.["traceparent"];
  const fromParent = typeof parent === "string" ? traceIdOfTraceparent(parent) : undefined;
  const inbound = [raw.properties.messageId, raw.properties.correlationId]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");
  return { kind: "delivery", id, traceId: fromParent ?? inbound ?? id };
};

/**
 * The trace id inside a W3C `traceparent` header, which outranks `messageId`
 * because it is the one value minted to span processes. Only the trace-id field
 * is taken: `traceId` is a correlation id, not a span context, so the parent's
 * span id is dropped rather than half-carried. The all-zero id is the spec's own
 * "invalid" and is refused like a malformed header.
 */
const traceIdOfTraceparent = (header: string): string | undefined => {
  const match = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(header.trim());
  const traceId = match?.[1];
  return traceId === undefined || /^0{32}$/.test(traceId) ? undefined : traceId;
};
