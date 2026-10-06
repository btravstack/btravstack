import { randomUUID } from "node:crypto";

import type { WorkerMiddleware } from "@amqp-contract/worker";
import {
  dispatchUnit,
  traceIdOfTraceparent,
  type AnyUnitModule,
  type Operation,
  type RuntimeHost,
  type Settle,
  type UnitMeta,
} from "@btravstack/core";

import { AmqpMessagePort } from "./handler.js";

/**
 * Open one kernel unit per delivery, forking `unit` — when one is bound — after
 * the message is validated, before the handler runs; the fork is torn down
 * when the unit closes. It is seeded with the validated delivery on
 * `AmqpMessage(contract)`, so a unit module derives a tenant from the message
 * rather than reading one off an ambient record. With no `unit` bound, `next()`
 * runs unchanged, so the ambient `currentUnit()` record is what the unit leaves
 * for the adapters that read it.
 *
 * The forked context rides the dispatcher's context, where each piece's own
 * wrapper turns it into the typed `context.unit` record that piece declared — the records live with the pieces, so a hand-composed
 * `amqp()` gets them without threading a second option through the starter.
 *
 * **The kernel's per-unit `AbortSignal` rides that record too**, and it is the
 * only route to it here: a handler has no parameter to receive one through. A
 * handler that must stop when the kernel stops waiting reads
 * `currentUnit()?.signal`.
 */
export const messageUnits =
  (
    host: RuntimeHost<never>,
    observers: readonly ((operation: Operation) => Settle)[],
    unit: AnyUnitModule | undefined,
  ): WorkerMiddleware =>
  (args, next) =>
    // A defect settles as a failed delivery too: this package nacks one
    // straight to the dead-letter queue, so a healthy rate beside a filling DLQ
    // is exactly the lie to avoid.
    dispatchUnit({
      host,
      observers,
      operation: {
        component: "amqp",
        name: "delivery",
        // The `consumers`/`rpcs` key, so the CONTRACT bounds the cardinality —
        // the queue name would too, but the key is what a reader of the
        // contract can look up. The payload is nowhere near the attributes.
        attributes: { handler: args.handlerName },
      },
      meta: metaFor(args.rawMessage),
      unit,
      seed: [AmqpMessagePort, args.message],
      next,
    });

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
  // `traceparent` outranks `messageId`: it is the one value minted to span
  // processes.
  const parent = raw.properties.headers?.["traceparent"];
  const fromParent = typeof parent === "string" ? traceIdOfTraceparent(parent) : undefined;
  const inbound = [raw.properties.messageId, raw.properties.correlationId]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");
  return { kind: "delivery", id, traceId: fromParent ?? inbound ?? id };
};
