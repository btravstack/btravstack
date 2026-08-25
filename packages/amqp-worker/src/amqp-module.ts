import type { ConsumerOptions } from "@amqp-contract/worker";
import type { ConfigInvalid, Env } from "@btravstack/config";
import {
  Module,
  type AnyModule,
  type AnyPort,
  type AnyProvider,
  type Exportable,
  type NeedsGate,
  type Provider,
} from "@btravstack/di";

import {
  AmqpRuntime,
  amqp,
  type AmqpConfig,
  type AmqpConnectionOptions,
  type AnyAmqpContract,
  type HandlersInstanceOf,
} from "./amqp-runtime.js";

/** The starter's own module, as the sugar adds it to the application's imports. */
type AmqpStarter<TContract extends AnyAmqpContract> = Module<
  AmqpRuntime | AmqpConfig,
  ConfigInvalid,
  Env | HandlersInstanceOf<TContract>
>;

/** The application's imports plus the starter — the tuple `Module(name)` is handed. */
type Imports<I extends readonly AnyModule[], TContract extends AnyAmqpContract> = readonly [
  ...I,
  AmqpStarter<TContract>,
];

/** The handlers provider plus the application's own — the tuple `Module(name)` is handed. */
type Provides<
  P extends readonly AnyProvider[],
  TContract extends AnyAmqpContract,
  HandlersError,
  HandlersNeeds,
> = readonly [Provider<HandlersInstanceOf<TContract>, HandlersError, HandlersNeeds>, ...P];

export type AmqpModuleOptions<
  TContract extends AnyAmqpContract,
  HandlersError,
  HandlersNeeds,
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
  X extends readonly Exportable<
    Imports<I, TContract>,
    Provides<P, TContract, HandlersError, HandlersNeeds>
  >[],
  N extends readonly AnyPort[],
> = {
  readonly contract: TContract;
  /** The application's handlers — what `AmqpHandlers(contract)(…)` returns for THIS contract. */
  readonly handlers: Provider<HandlersInstanceOf<TContract>, HandlersError, HandlersNeeds>;
  /** Pins the broker instead of reading `AMQP_URL` — a test's container. */
  readonly url?: string;
  /** See `AmqpOptions.connectionOptions`. */
  readonly connectionOptions?: AmqpConnectionOptions;
  /** See `AmqpOptions.defaultConsumerOptions`. */
  readonly defaultConsumerOptions?: ConsumerOptions;
  /** See `AmqpOptions.connectTimeoutMs`. */
  readonly connectTimeoutMs?: number;
  readonly imports?: I;
  readonly provides?: P;
  /** The application's own exports; `AmqpRuntime` is added, since `start` resolves it. */
  readonly exports?: X;
  /**
   * What this root's OWN providers expect from outside. di's gate is re-stated
   * over the augmented tuples below, so forgetting one is an error at THIS call.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I, TContract>, Provides<P, TContract, HandlersError, HandlersNeeds>, N>;

/**
 * `Module(name)({...})` for an AMQP deployment: everything a di module takes,
 * plus the contract and the handlers provider. The sugar imports the starter,
 * provides the handlers and exports `AmqpRuntime`, handing back exactly the
 * module `Module(...)` would have declared over the augmented tuples.
 *
 * ```ts
 * export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
 *   contract: orderContract,
 *   handlers: orderHandlers,
 *   imports: [OrderApplicationModule, OrderPersistenceModule],
 *   exports: [Logger],
 * });
 * await runMain(OrderAmqpWorker);
 * ```
 */
export const AmqpModule =
  <const Name extends string>(name: Name) =>
  <
    TContract extends AnyAmqpContract,
    HandlersError,
    HandlersNeeds,
    const I extends readonly AnyModule[] = [],
    const P extends readonly AnyProvider[] = [],
    const X extends readonly Exportable<
      Imports<I, TContract>,
      Provides<P, TContract, HandlersError, HandlersNeeds>
    >[] = [],
    const N extends readonly AnyPort[] = [],
  >(
    options: AmqpModuleOptions<TContract, HandlersError, HandlersNeeds, I, P, X, N>,
  ) => {
    const { contract, handlers, url, connectionOptions, defaultConsumerOptions, connectTimeoutMs } =
      options;
    const imports = (options.imports ?? []) as I;
    const provides = (options.provides ?? []) as P;
    const exports = (options.exports ?? []) as X;
    const starter = amqp({
      contract,
      ...(url === undefined ? {} : { url }),
      ...(connectionOptions === undefined ? {} : { connectionOptions }),
      ...(defaultConsumerOptions === undefined ? {} : { defaultConsumerOptions }),
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    });
    // The assertion is the gate, not the shape: `NeedsGate` defers while the
    // tuples are type parameters, and is computed at the application's own call
    // because the options type re-declares it. Spelled out rather than
    // `as never`, which collapses the return to `Module<never, never, never>`.
    return Module(name)({
      imports: [...imports, starter] as Imports<I, TContract>,
      provides: [handlers, ...provides] as Provides<P, TContract, HandlersError, HandlersNeeds>,
      exports: [AmqpRuntime, ...exports] as readonly [typeof AmqpRuntime, ...X],
      needs: (options.needs ?? []) as N,
    } as {
      readonly imports: Imports<I, TContract>;
      readonly provides: Provides<P, TContract, HandlersError, HandlersNeeds>;
      readonly exports: readonly [typeof AmqpRuntime, ...X];
      readonly needs: N;
    } & NeedsGate<Imports<I, TContract>, Provides<P, TContract, HandlersError, HandlersNeeds>, N>);
  };
