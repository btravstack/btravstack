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
 * A worker with several consumers is several pieces, each declaring the
 * services its own handler calls; `AmqpHandlers(contract)([...])` composes
 * them. `contract` is read for its **type** only — it is what types `key` and
 * the handler, so a consumer the contract does not declare, or a handler whose
 * message has drifted, is a compile error here rather than at the root.
 *
 * There is no name to give: the contract key IS the port's name. The port is
 * minted for you and carried back on `provider.port`, and the return is di's
 * own `Provider(port)`, so every arm — `value` / `sync` / `make` / `class` /
 * `acquire` — is available exactly as it is on `AmqpHandlers(contract)`.
 */
export const AmqpHandler = <C extends AnyAmqpContract, const K extends HandlerKeyOf<C>>(
  contract: C,
  key: K,
): ReturnType<typeof Provider<HandlerPortOf<C, K>>> => {
  // The parameter is named, not `_`-prefixed, so it reads as `contract` in the
  // published `.d.ts` and in an editor hint; nothing needs its value.
  void contract;
  // oxlint-disable-next-line typescript/no-extraneous-class -- a port is a phantom token; only a class expression carries the construct signature `PortClassOf` describes
  const port = class extends Port(`${HANDLER_PREFIX}${key}`)<WorkerInferHandlers<C>[K]> {};
  return Provider(port as never) as never;
};
