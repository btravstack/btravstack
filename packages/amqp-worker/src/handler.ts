import type { WorkerInferHandlers } from "@amqp-contract/worker";
import {
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";

import type { AnyAmqpContract } from "./amqp-runtime.js";
import { withUnit, type UnitRecordOf } from "./unit.js";

/** The consumer and rpc names `C` declares — the keys of its handlers record. */
export type HandlerKeyOf<C extends AnyAmqpContract> = keyof WorkerInferHandlers<C> & string;

/**
 * The validated delivery, typed by the contract: the union of every consumer's
 * and rpc's own consumed message. Reached through the handler's own second
 * parameter, since `@amqp-contract/worker` exports
 * `WorkerInferConsumedMessage` but not the `InferConsumerNames` constraint it
 * takes — the same by-index route {@link AnyAmqpContract} travels.
 */
export type AmqpMessageOf<C extends AnyAmqpContract> = Parameters<
  Extract<WorkerInferHandlers<C>[HandlerKeyOf<C>], (...args: never) => unknown>
>[1];

/** The seeded port's class, typed for `C`: what `AmqpMessage(contract)` answers. */
export type AmqpMessagePortOf<C extends AnyAmqpContract> = PortClassOf<
  "AmqpMessage",
  AmqpMessageOf<C>
>;

/**
 * The seed's port instance, as it appears in a needs union — subtracted from
 * what a bound `unit.message` module still owes, since the fork is what
 * discharges it.
 */
export type AmqpMessageInstance = PortInstance<"AmqpMessage", unknown>;

/** One id, declared once, so no contract instantiating it warns about a duplicate. */
export const AmqpMessagePort = Port("AmqpMessage");

/**
 * The validated delivery as a port: the one thing the worker seeds the fork
 * with, so a `unit.message` module derives a tenant — or anything else — from
 * the message rather than from an ambient record.
 *
 * ```ts
 * const Message = AmqpMessage(orderContract);
 * const MessageUnit = Module("MessageUnit")({
 *   needs: [Message],
 *   provides: [Provider(Tenant)({ inject: { message: Message }, sync: ({ message }) => message.payload.tenantId })],
 *   exports: [Tenant],
 * });
 * ```
 *
 * `contract` is read for its TYPE only. One `Port(...)` call fixed per contract
 * at the type level, the move `AmqpHandlersPort` makes, so a module built for
 * one contract cannot read another's message.
 */
export const AmqpMessage = <C extends AnyAmqpContract>(contract: C): AmqpMessagePortOf<C> => {
  void contract;
  return AmqpMessagePort as AmqpMessagePortOf<C>;
};

/**
 * The port one piece targets. Its id carries the contract key, which is what
 * makes two slices claiming one consumer di's duplicate-provider defect rather
 * than a silent merge.
 */
export type HandlerPortOf<C extends AnyAmqpContract, K extends HandlerKeyOf<C>> = PortClassOf<
  `${typeof HANDLER_PREFIX}${K}`,
  WorkerInferHandlers<C>[K]
>;

/** The prefix a piece's port id carries; the composing form strips it to recover the key. */
export const HANDLER_PREFIX = "AmqpHandler:";

/** What a minted piece returns. */
type MintedHandler<
  C extends AnyAmqpContract,
  K extends HandlerKeyOf<C>,
  N,
  U extends Readonly<Record<string, AnyPort>>,
> = Provider<InstanceType<HandlerPortOf<C, K>>, never, N> & {
  readonly port: HandlerPortOf<C, K>;
  /** The declared `unit:` record, which `AmqpHandlers`'s array arm reads back off the piece. */
  readonly unit: U;
  /** Phantom: the ports this piece injects, which the root's `unit.message` must export. */
  readonly _declared?: InstanceType<U[keyof U]>;
};

/**
 * One consumer or rpc of a contract, as a provider on a port of its own.
 *
 * A worker with several consumers is several pieces, each declaring the services
 * its own handler calls; `AmqpHandlers(contract)([...])` composes them.
 * `contract` is read for its TYPE only, and types both `key` and the handler —
 * so a consumer the contract does not declare is a compile error here.
 *
 * There is no name to give: the contract key IS the port's name.
 *
 * `unit` declares the ports the handler reads off `context.unit`, resolved out
 * of the fork the delivery opened; the root's `unit.message` module must export
 * every one of them.
 */
export const AmqpHandler = <C extends AnyAmqpContract, const K extends HandlerKeyOf<C>>(
  contract: C,
  key: K,
) => {
  // Named rather than `_`-prefixed so it reads as `contract` in the published
  // `.d.ts`; nothing needs its value.
  void contract;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const port = class extends Port(`${HANDLER_PREFIX}${key}`)<WorkerInferHandlers<C>[K]> {};

  return <
    const D extends Readonly<Record<string, AnyPort>>,
    const U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
  >(options: {
    readonly inject: D;
    /** The unit-scoped ports this handler reads off `context.unit`. */
    readonly unit?: U;
    readonly sync: (services: {
      readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
    }) => WorkerInferHandlers<C, { readonly unit: UnitRecordOf<U> }>[K &
      keyof WorkerInferHandlers<C, { readonly unit: UnitRecordOf<U> }>];
  }): MintedHandler<C, K, InstanceType<D[keyof D]>, U> => {
    const record = options.unit ?? {};
    return Object.assign(
      Provider(port as never)({
        inject: options.inject,
        sync: (services: never) => withUnit(record, options.sync(services)),
      } as never),
      { unit: record },
    ) as never;
  };
};
