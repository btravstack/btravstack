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
  /** The application's handlers — `AmqpHandlers(contract)(deps, arm)`, one per `consumers` / `rpcs` key of THIS contract, as the provider that builds them from the services they call. */
  readonly handlers: Provider<HandlersInstanceOf<TContract>, HandlersError, HandlersNeeds>;
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
  /**
   * What this root expects from outside — `Env` at least, since the starter
   * binds its connection from it and `start` is what provides it. di's own
   * gate is re-stated over the augmented tuples below, so forgetting one is
   * an error at THIS call, the same as it would be on a bare `Module(name)`.
   */
  readonly needs?: N;
} & NeedsGate<Imports<I, TContract>, Provides<P, TContract, HandlersError, HandlersNeeds>, N>;

/**
 * `Module(name)({...})` for an AMQP deployment: everything a di module takes,
 * plus the contract and the handlers provider, and nothing else to know. The
 * sugar imports the starter (`amqp({ contract })`), provides the
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
    // di's own `Module(name)({...})` over the augmented tuples: its return
    // type IS the sugar's — nothing spelled twice.
    // The assertion is the gate, not the shape: `NeedsGate` cannot be computed
    // while the tuples are still type parameters, so it defers and no object
    // literal satisfies it here. It IS computed at the application's own call,
    // because the sugar re-declares it on its options type. Asserting to a
    // spelled-out type rather than `as never` is what keeps the tuples
    // inferred — `as never` collapses the return to `Module<never, never, never>`.
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
