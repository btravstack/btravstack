import {
  TypedAmqpWorker,
  type ConsumerOptions,
  type WorkerInferHandlers,
} from "@amqp-contract/worker";
import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import {
  Observers,
  RuntimePort,
  RuntimeStartFailed,
  noObserver,
  releasedBy,
  type Operation,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type Settle,
} from "@btravstack/core";
import {
  Module,
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type PortInstance,
  type Scope,
  type ServiceOf,
} from "@btravstack/di";
import { P, type AsyncResult } from "unthrown";

import {
  HANDLER_PREFIX,
  type AmqpMessageInstance,
  type HandlerKeyOf,
  type HandlerPortOf,
} from "./handler.js";
import { messageUnits } from "./message-units.js";
import { withUnit, type UnitRecordOf } from "./unit.js";

/** What the worker publishes once it is consuming, read back through `RunningApp.runtimeInfo()`. */
export type AmqpInfo = { readonly queues: readonly string[] };

/**
 * The broker, as a service: `amqp()` binds it from `AMQP_URL` (default
 * `amqp://127.0.0.1:5672`) and `AMQP_CONNECT_TIMEOUT_MS` (default `5_000`)
 * unless pinned, and anything else in the graph may read it — a publisher
 * sharing the consumer's broker, say.
 */
export class AmqpConfig extends Port("AmqpConfig")<{
  readonly url: string;
  /** How long `create` waits for the connection before failing. */
  readonly connectTimeoutMs: number;
}> {}

/**
 * Five seconds. The library's own default is 30, which is longer than most
 * orchestrators wait before restarting the pod — an unreachable broker should
 * be reported, not sat on.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** The runtime's port: what `amqp()` provides, and what the module `start` boots must export. */
export class AmqpRuntime extends RuntimePort<Runtime<never, AmqpInfo>> {}

/**
 * A module `unit.message` may bind, as the upper bound `amqp()` constrains its
 * own `Unit` type parameter to. `Module`'s `_exports` channel is contravariant,
 * so `Exports = never` — never `unknown` — is what makes a REAL module's own
 * (necessarily narrower) export type assignable to this bound: `(x: Concrete)
 * => void` is assignable to `(x: never) => void`, not to `(x: unknown) =>
 * void`.
 */
export type AnyUnitModule = Module<never, never, unknown>;

/**
 * The needs a bound `unit.message` module still owes, or `never` when none is
 * bound. `Scope` is excluded, since nothing can ever provide it — the same
 * exemption `NeedsGate` itself carries — and so is the delivery, which the
 * fork's own seed discharges.
 */
export type UnitNeedsOf<Unit> =
  Unit extends Module<never, never, infer N> ? Exclude<N, Scope | AmqpMessageInstance> : never;

/**
 * The contract type `TypedAmqpWorker.create` accepts, extracted rather than
 * imported by name so `@amqp-contract/contract` stays out of the peer range.
 */
export type AnyAmqpContract = Parameters<typeof TypedAmqpWorker.create>[0]["contract"];

/**
 * The connection tuning `TypedAmqpWorker.create` accepts — heartbeat,
 * reconnect interval, `findServers`, TLS/socket options. The library declares
 * it (`AmqpConnectionManagerOptions`) without exporting it by name, so it is
 * reached by index for the same reason {@link AnyAmqpContract} is.
 */
export type AmqpConnectionOptions = NonNullable<
  Parameters<typeof TypedAmqpWorker.create>[0]["connectionOptions"]
>;

/**
 * The handlers' port — one id, the starter's own, which an application never
 * names. Generic at the value level (one `Port(...)` call, so no duplicate-id
 * warning however many contracts instantiate it) and fixed per contract at the
 * type level through `HandlersPortOf<C>`, so a provider built for one contract
 * cannot be handed to a module declaring another. Exported for this package's
 * tests, not from `index.ts`.
 */
export const AmqpHandlersPort = Port("AmqpHandlers");

/** The handlers port class, typed for `C`: what `AmqpHandlers(contract)(…).port` is. */
export type HandlersPortOf<C extends AnyAmqpContract> = PortClassOf<
  "AmqpHandlers",
  WorkerInferHandlers<C>
>;

/** The handlers port's instance for `C` — the module's one need. */
export type HandlersInstanceOf<C extends AnyAmqpContract> = PortInstance<
  "AmqpHandlers",
  WorkerInferHandlers<C>
>;

export type AmqpOptions<
  TContract extends AnyAmqpContract,
  Unit extends AnyUnitModule | undefined = undefined,
> = {
  /**
   * The contract; the handlers port is typed by it — one handler per
   * `consumers` / `rpcs` key, with no injected context, since a handler is
   * built by di from the services it declares.
   */
  readonly contract: TContract;
} & AmqpTuning<Unit>;

/**
 * What an AMQP deployment tunes, shared verbatim by `amqp()` and `AmqpModule` —
 * spelled once so the two cannot drift, which is what a second copy of an
 * option list always eventually does.
 */
export type AmqpTuning<Unit extends AnyUnitModule | undefined = undefined> = {
  /** Pins `AmqpConfig.url` instead of reading `AMQP_URL` — a test's container. */
  readonly url?: string;
  /** Connection tuning, `@amqp-contract/worker`'s own type: heartbeat, reconnect interval, `findServers`, TLS/socket options. */
  readonly connectionOptions?: AmqpConnectionOptions;
  /** Consumer defaults applied to every handler, the library's own type: `prefetch`, `priority`, `arguments`, `consumerTag`, `exclusive`. */
  readonly defaultConsumerOptions?: ConsumerOptions;
  /**
   * Pins `AmqpConfig.connectTimeoutMs` instead of reading
   * `AMQP_CONNECT_TIMEOUT_MS` (default {@link DEFAULT_CONNECT_TIMEOUT_MS}) —
   * how long `create` waits for the connection before failing. Passed straight
   * through as a top-level `CreateWorkerOptions` field, NOT nested under
   * `connectionOptions`, where setting it is silently inert.
   */
  readonly connectTimeoutMs?: number;
  /**
   * The unit module the worker forks around every delivery it dispatches,
   * seeded with the validated message on `AmqpMessage(contract)`. Built after
   * the message is validated, torn down when the unit closes; what it exports
   * is what a piece may declare on its own `unit:` record.
   */
  readonly unit?: { readonly message?: Unit };
};

/**
 * The AMQP starter: a module providing the runtime and its configuration (bound
 * from `AMQP_URL` unless pinned), built over the handlers the application
 * provides on the starter's own handlers port — the module's one need. Import
 * it next to the application, provide the handlers, export `AmqpRuntime`.
 *
 * With `url` pinned the module reads nothing from the environment.
 */
export const amqp = <
  TContract extends AnyAmqpContract,
  Unit extends AnyUnitModule | undefined = undefined,
>(
  options: AmqpOptions<TContract, Unit>,
): Module<
  AmqpRuntime | AmqpConfig,
  ConfigInvalid,
  Env | HandlersInstanceOf<TContract> | UnitNeedsOf<Unit>
> => {
  const config = Config.provider(AmqpConfig)(
    Config.object({
      url: Config.pinned(
        options.url,
        Config.string("AMQP_URL", { default: "amqp://127.0.0.1:5672" }),
      ),
      connectTimeoutMs: Config.pinned(
        options.connectTimeoutMs,
        Config.integer("AMQP_CONNECT_TIMEOUT_MS", { default: DEFAULT_CONNECT_TIMEOUT_MS, min: 0 }),
      ),
    }),
  );
  return Module("Amqp")({
    needs: [Env, AmqpHandlersPort as HandlersPortOf<TContract>],
    provides: [
      config,
      // The no-op member, so the set this module reads is never the empty
      // dependency di refuses: a graph composing no observability still starts.
      Provider.member(Observers)({ inject: {}, value: noObserver }),
      Provider(AmqpRuntime)({
        inject: {
          config: AmqpConfig,
          handlers: AmqpHandlersPort as HandlersPortOf<TContract>,
          observers: Observers,
        },
        sync: ({ config: bound, handlers, observers }): Runtime<never, AmqpInfo> => ({
          name: "amqp",
          resolves: [],
          start: (host) => createWorker(host, bound, options, handlers, observers),
        }),
      }),
    ],
    exports: [AmqpRuntime, AmqpConfig],
    // `as never`/`as unknown as Module<…>`, below: the Needs channel carries a
    // bound `unit.message` module's own unmet needs, though nothing HERE reads
    // them — it is forked over the application context at dispatch, so what it
    // needs is exactly what the composition root must supply, and this is what
    // makes di's own `UNSATISFIED DEPENDENCIES` gate say so.
  } as never) as unknown as Module<
    AmqpRuntime | AmqpConfig,
    ConfigInvalid,
    Env | HandlersInstanceOf<TContract> | UnitNeedsOf<Unit>
  >;
};

/** One piece of the handlers record — what `AmqpHandler(contract, key)(…)` returns, as the composing form consumes it. */
type PieceOf<C extends AnyAmqpContract> = {
  readonly [K in HandlerKeyOf<C>]: {
    readonly port: HandlerPortOf<C, K>;
    /** Phantom, carrying the ports the piece injects off `context.unit`. */
    readonly _declared?: unknown;
  };
}[HandlerKeyOf<C>];

/** Every port the pieces in `T` inject off `context.unit` — what the root's `unit.message` must export. */
type DeclaredOf<T extends readonly { readonly _declared?: unknown }[]> = NonNullable<
  T[number]["_declared"]
>;

/** The key a piece carries, read back off its port id. */
type KeyOfPiece<P> = P extends {
  readonly port: { readonly portId: `${typeof HANDLER_PREFIX}${infer K}` };
}
  ? K
  : never;

/** The consumers and rpcs no piece in `T` covers. */
type Uncovered<C extends AnyAmqpContract, T extends readonly PieceOf<C>[]> = Exclude<
  HandlerKeyOf<C>,
  KeyOfPiece<T[number]>
>;

/**
 * A refused array: as long as the array the caller wrote, its head the caller's
 * own elements — which match — and its LAST element the marker paired with what
 * is wrong.
 *
 * TypeScript compares two equal-length tuples element by element, so the extra
 * diagnostic it reports lands on the trailing element and carries both the
 * sentence and the missing key. A fixed two-element tuple named the key only
 * when the array happened to be two elements long; every other arity was a
 * length mismatch, and the developer diffed the contract against the array by
 * hand.
 */
type Refuse<T extends readonly unknown[], Marker extends string, Detail> = T extends readonly [
  ...infer Head,
  unknown,
]
  ? readonly [...Head, readonly [Marker, Detail]]
  : readonly [readonly [Marker, Detail]];

/**
 * The record arm: the whole handlers record from one `sync`, with one `unit:`
 * record shared by every entry in it.
 *
 * It is `{ inject, unit?, sync }` — di's other arms are gone — for PARITY, not
 * for a type-system reason: `value` could have carried the record just as well,
 * since `U` infers from `unit` and never from the arm. `@btravstack/http-server`'s
 * `api.OrpcRouter(contract)` is `{ inject, unit?, sync }` and so are all three
 * packages' piece factories, so one arm across the family is one surface to
 * learn and one to keep.
 */
type Whole<C extends AnyAmqpContract> = <
  const D extends Readonly<Record<string, AnyPort>>,
  const U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
>(options: {
  readonly inject: D;
  /** The unit-scoped ports every handler in the record reads off `context.unit`. */
  readonly unit?: U;
  readonly sync: (services: {
    readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
  }) => WorkerInferHandlers<C, { readonly unit: UnitRecordOf<U> }>;
}) => Provider<HandlersInstanceOf<C>, never, InstanceType<D[keyof D]>> & {
  readonly port: HandlersPortOf<C>;
  /** Phantom: the declared ports, which `AmqpModule` gates `unit.message` against. */
  readonly _declaredUnit?: InstanceType<U[keyof U]>;
};

/**
 * The composing arm. Declared LAST in the intersection below on purpose:
 * TypeScript reports the last overload's failure, so a non-covering array is
 * refused against the `"UNCOVERED HANDLERS — …"` marker rather than degrading
 * to di's `Qualification`, which names nothing.
 *
 * The marker is a sentence rather than a bare label because it prints last,
 * after the caller's own several-hundred-character piece type.
 */
type Compose<C extends AnyAmqpContract> = <const T extends readonly PieceOf<C>[]>(
  pieces: [Uncovered<C, T>] extends [never]
    ? T
    : Refuse<
        T,
        "UNCOVERED HANDLERS — the contract declares a consumer this array does not cover",
        Uncovered<C, T>
      >,
) => Provider<HandlersInstanceOf<C>, never, InstanceType<T[number]["port"]>> & {
  readonly port: HandlersPortOf<C>;
  /** Phantom: the union of every piece's declared ports, which `AmqpModule` gates `unit.message` against. */
  readonly _declaredUnit?: DeclaredOf<T>;
};

/**
 * The handlers as a provider, from the contract. Two call forms, one port.
 *
 * ```ts
 * AmqpHandlers(orderContract)({ inject: { logger: Logger }, sync: ({ logger }) => ({ orderNotifications: (m) => … }) })
 * AmqpHandlers(orderContract)([orderNotifications, orderAudit])
 * ```
 *
 * The first is `{ inject, unit?, sync }`, whose `sync` hands back the whole
 * handlers record — one `unit:` record for every entry in it. The second takes
 * the pieces `AmqpHandler(contract, key)` builds: they are the provider's deps,
 * keyed by the contract key each piece's port id carries, so the services
 * record IS the handlers record. Every declared key must be covered, and two
 * slices claiming one key are di's duplicate-provider defect at build.
 */
export const AmqpHandlers = <C extends AnyAmqpContract>(contract: C): Whole<C> & Compose<C> => {
  void contract;
  const build = Provider(AmqpHandlersPort as HandlersPortOf<C>);
  const compose = (pieces: readonly { readonly port: { readonly portId: string } }[]): unknown =>
    build({
      inject: Object.fromEntries(
        pieces.map((piece) => [piece.port.portId.slice(HANDLER_PREFIX.length), piece.port]),
      ),
      sync: (services: unknown) => services,
    } as never);
  const whole = (options: {
    readonly inject: Readonly<Record<string, AnyPort>>;
    readonly unit?: Readonly<Record<string, AnyPort>>;
    readonly sync: (services: never) => Readonly<Record<string, unknown>>;
  }): unknown => {
    const record = options.unit ?? {};
    return build({
      inject: options.inject,
      sync: (services: never) =>
        Object.fromEntries(
          Object.entries(options.sync(services)).map(([key, entry]) => [
            key,
            withUnit(record, entry),
          ]),
        ),
    } as never);
  };
  // An array is never a valid record call — its one argument is a record — so
  // `Array.isArray` alone identifies the composing arm.
  return ((first: unknown) =>
    Array.isArray(first)
      ? compose(first as readonly { readonly port: { readonly portId: string } }[])
      : whole(first as Parameters<typeof whole>[0])) as never;
};

const startFailed = (cause: unknown): RuntimeStartFailed =>
  new RuntimeStartFailed({ runtime: "amqp", cause });

/**
 * Every queue the contract's consumers and RPCs drain, sorted and
 * de-duplicated. Derived rather than configured, so `Serving.info` cannot
 * disagree with what the worker actually consumes.
 */
const queuesOf = (contract: AnyAmqpContract): readonly string[] =>
  [
    ...new Set(
      Object.values({ ...contract.consumers, ...contract.rpcs }).map((entry) => entry.queue.name),
    ),
  ].sort();

const createWorker = <TContract extends AnyAmqpContract, Unit extends AnyUnitModule | undefined>(
  host: RuntimeHost<never>,
  config: ServiceOf<AmqpConfig>,
  options: AmqpOptions<TContract, Unit>,
  handlers: WorkerInferHandlers<TContract>,
  observers: readonly ((operation: Operation) => Settle)[],
): AsyncResult<Serving<AmqpInfo>, RuntimeStartFailed> =>
  TypedAmqpWorker.create({
    contract: options.contract,
    handlers,
    middleware: messageUnits(host, observers, options.unit?.message),
    urls: [config.url],
    ...(options.connectionOptions === undefined
      ? {}
      : { connectionOptions: options.connectionOptions }),
    ...(options.defaultConsumerOptions === undefined
      ? {}
      : { defaultConsumerOptions: options.defaultConsumerOptions }),
    connectTimeoutMs: config.connectTimeoutMs,
  })
    .map((worker) => consume(worker, queuesOf(options.contract)))
    // An unreachable broker is `create`'s own modeled error, so it is named
    // rather than fished out of the defect channel: it becomes the kernel's
    // startup failure, which is `runMain`'s exit code 1. Everything else that
    // can go wrong in there — a topology the broker refuses, a bad option, a
    // bug in a provider — stays a DEFECT and exits 70, which is the
    // distinction a blanket `recoverDefect` used to erase.
    .mapErrCases((matcher) =>
      matcher.with(P.tag("@amqp-contract/ConnectionError"), (error) => startFailed(error)),
    );

const consume = (worker: TypedAmqpWorker<never>, queues: readonly string[]): Serving<AmqpInfo> => {
  // Memoised because both methods reach it and the kernel calls `stop` after
  // `drain` on the signal path. The result is HELD, not dropped: `close()` can
  // defect, and an empty error channel is not an empty defect channel.
  let closing: AsyncResult<void, never> | undefined;
  const beginClose = (): AsyncResult<void, never> =>
    (closing ??= worker.close({ drainTimeoutMs: null }));

  // The kernel's deadline, kept from `drain` so `stop` is released by the same
  // abort. `drainTimeoutMs: null` is deliberate: the library's own 30s default
  // sits above the kernel's 20s one and would quietly win.
  let deadline: AbortSignal | undefined;
  const stopped = (): AsyncResult<void, never> =>
    deadline === undefined ? beginClose() : releasedBy(deadline, beginClose());

  return {
    info: { queues },
    drain: (signal) => {
      deadline = signal;
      return stopped();
    },
    stop: () => stopped(),
  };
};
