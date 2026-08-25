import type { WorkerInferHandlers } from "@amqp-contract/worker";
import { Port, Provider, type PortClassOf } from "@btravstack/di";

import type { AnyAmqpContract } from "./amqp-runtime.js";

/** The consumer and rpc names `C` declares — the keys of its handlers record. */
export type HandlerKeyOf<C extends AnyAmqpContract> = keyof WorkerInferHandlers<C> & string;

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

/**
 * One consumer or rpc of a contract, as a provider on a port of its own.
 *
 * A worker with several consumers is several pieces, each declaring the services
 * its own handler calls; `AmqpHandlers(contract)([...])` composes them.
 * `contract` is read for its TYPE only, and types both `key` and the handler —
 * so a consumer the contract does not declare is a compile error here.
 *
 * There is no name to give: the contract key IS the port's name.
 */
export const AmqpHandler = <C extends AnyAmqpContract, const K extends HandlerKeyOf<C>>(
  contract: C,
  key: K,
): ReturnType<typeof Provider<HandlerPortOf<C, K>>> => {
  // Named rather than `_`-prefixed so it reads as `contract` in the published
  // `.d.ts`; nothing needs its value.
  void contract;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const port = class extends Port(`${HANDLER_PREFIX}${key}`)<WorkerInferHandlers<C>[K]> {};
  return Provider(port as never) as never;
};
