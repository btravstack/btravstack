import type { WorkerInferHandlers } from "@amqp-contract/worker";
import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyProvider,
  type Available,
  type ErrOf,
  type ErrOfModule,
  type Exportable,
  type NeedOf,
  type NeedsOfModule,
  type Provider,
  type ResolvedExports,
  type ServiceOf,
} from "@btravstack/di";

import { AmqpRuntime, amqp, type AmqpConfig, type AnyAmqpContract } from "./amqp-runtime.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type AmqpStarter<HandlersInstance> = Module<
  AmqpRuntime | AmqpConfig,
  ConfigInvalid,
  Env | HandlersInstance
>;

/**
 * `unknown` when the provider's port carries the handlers record `TContract`
 * wants with no injected context, `never` otherwise — intersected with the
 * provider at the call site, so a provider of anything else fails to
 * typecheck there. The same check `amqp()` makes on the port class, made on
 * the provider's instance type.
 */
type HandlersProvider<HandlersInstance, TContract extends AnyAmqpContract> =
  ServiceOf<HandlersInstance> extends WorkerInferHandlers<TContract> ? unknown : never;

export type AmqpModuleOptions<
  TContract extends AnyAmqpContract,
  HandlersInstance,
  HandlersError,
  HandlersNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    [...I, AmqpStarter<HandlersInstance>],
    [Provider<HandlersInstance, HandlersError, HandlersNeeds>, ...P]
  >[],
> = {
  readonly contract: TContract;
  /** The application's handlers — one per `consumers` / `rpcs` key of `contract` — as the provider that builds them from the services they call. */
  readonly handlers: Provider<HandlersInstance, HandlersError, HandlersNeeds> &
    HandlersProvider<HandlersInstance, TContract>;
  /** Pins the broker instead of reading `AMQP_URL` — a test's container. */
  readonly url?: string;
  readonly connectionOptions?: Record<string, unknown>;
  readonly defaultConsumerOptions?: Record<string, unknown>;
  /** See `AmqpOptions.connectTimeoutMs`. */
  readonly connectTimeoutMs?: number;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `AmqpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
};

/**
 * `Module(name)({...})` for an AMQP deployment: everything a di module takes,
 * plus the contract and the handlers provider, and nothing else to know. The
 * sugar imports the starter (`amqp({ contract, handlers })`), provides the
 * handlers, and exports `AmqpRuntime` — so a root that would otherwise write
 * those two lines and remember that `start` needs the runtime exported writes
 * neither. It hands back exactly the module `Module(...)` would have declared
 * over the augmented `imports`/`provides`/`exports` (spelled from di's own
 * pieces), so the kernel, `start`'s gate and di's see nothing new: syntax over
 * the same primitives, one source of truth.
 *
 * ```ts
 * export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
 *   contract: orderContract,
 *   handlers: orderHandlers,
 *   imports: [ApplicationModule, PersistenceModule],
 *   exports: [Logger],
 * });
 * await runMain(OrderAmqpWorker);
 * ```
 */
export const AmqpModule =
  <const Name extends string>(name: Name) =>
  <
    TContract extends AnyAmqpContract,
    HandlersInstance,
    HandlersError,
    HandlersNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      [...I, AmqpStarter<HandlersInstance>],
      [Provider<HandlersInstance, HandlersError, HandlersNeeds>, ...P]
    >[] = [],
  >(
    options: AmqpModuleOptions<TContract, HandlersInstance, HandlersError, HandlersNeeds, I, P, X>,
  ): Module<
    ResolvedExports<[typeof AmqpRuntime, ...X]>,
    | ErrOf<[Provider<HandlersInstance, HandlersError, HandlersNeeds>, ...P][number]>
    | ErrOfModule<[...I, AmqpStarter<HandlersInstance>][number]>,
    Exclude<
      | NeedOf<[Provider<HandlersInstance, HandlersError, HandlersNeeds>, ...P][number]>
      | NeedsOfModule<[...I, AmqpStarter<HandlersInstance>][number]>,
      Available<
        [...I, AmqpStarter<HandlersInstance>],
        [Provider<HandlersInstance, HandlersError, HandlersNeeds>, ...P]
      >
    >
  > => {
    const {
      contract,
      handlers,
      url,
      connectionOptions,
      defaultConsumerOptions,
      connectTimeoutMs,
      imports = [],
      provides = [],
      exports = [],
    } = options;
    // `handlers.port` is the port class the provider targets — `AnyPort` at
    // this level; the constraint that its service is the contract's handlers
    // was checked on the provider's instance type above, so `amqp()`'s
    // class-level check has nothing left to add.
    const starter = amqp({
      contract,
      handlers: handlers.port as never,
      ...(url === undefined ? {} : { url }),
      ...(connectionOptions === undefined ? {} : { connectionOptions }),
      ...(defaultConsumerOptions === undefined ? {} : { defaultConsumerOptions }),
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    });
    // The typing above is the whole contract; the value is the plain module
    // it describes. `never` because di computes the declared type from the
    // literal it is handed, and generic `I`/`P`/`X` are not one.
    return Module(name)({
      imports: [...imports, starter],
      provides: [handlers, ...provides],
      exports: [AmqpRuntime, ...exports],
    } as never) as never;
  };
