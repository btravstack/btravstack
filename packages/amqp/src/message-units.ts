import { randomUUID } from "node:crypto";

import type { RuntimeHost, UnitMeta } from "@btravstack/core";
import type { AnyPort, Context } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

/** What the middleware injects downstream: the application context, and nothing else. */
export type MessageUnitContext<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
};

/**
 * The shape of `amqp-contract`'s `WorkerMiddleware`, declared here rather than
 * imported. Structural typing makes the two compatible, and it keeps
 * `amqp-contract` out of this package's peer range.
 */
export type MessageMiddleware<Needs extends AnyPort> = (
  args: {
    readonly message: { readonly payload: unknown; readonly headers: unknown };
    readonly rawMessage: RawDelivery;
    readonly handlerName: string;
    readonly isRpc: boolean;
    readonly context: Record<never, never>;
  },
  next: (patch?: {
    readonly payload?: unknown;
    readonly context?: MessageUnitContext<Needs>;
    // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- the chain's failure union is `amqp-contract`'s to name; this package is transparent to it and must accept whatever arrives
  }) => AsyncResult<unknown, unknown>,
) => AsyncResult<unknown, never>;

type RawDelivery = {
  readonly properties: {
    readonly messageId?: string | undefined;
    readonly correlationId?: string | undefined;
  };
};

/**
 * Open one kernel unit per delivery, and hand the unit's context — the
 * application context, or the per-unit fork when `StartOptions.unit` is set —
 * downstream through `amqp-contract`'s own per-message context channel.
 *
 * **Pass the type argument** — `messageUnits<typeof PlaceOrder | typeof Logger>(host)`
 * — whenever a handler reads `context.ctx`. TypeScript infers the injected
 * context from the middleware's own type and infers nothing from a generic
 * call it is still resolving.
 */
export const messageUnits =
  <Needs extends AnyPort>(host: RuntimeHost<Needs>): MessageMiddleware<Needs> =>
  (args, next) =>
    // The one cast in the package; see `-temporal`'s `activityUnits` for the
    // full reasoning. `never` on the way out is the only channel that types:
    // the value must be assignable to the failure union `amqp-contract` names
    // and this package deliberately does not import.
    host.run(metaFor(args.rawMessage), (ctx) => next({ context: { ctx } })) as AsyncResult<
      unknown,
      never
    >;

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
const metaFor = (raw: RawDelivery): UnitMeta => {
  const id = randomUUID();
  const inbound = [raw.properties.messageId, raw.properties.correlationId]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");

  return { kind: "delivery", id, traceId: inbound ?? id };
};
