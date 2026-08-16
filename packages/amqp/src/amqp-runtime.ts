import { TypedAmqpWorker, type WorkerInferHandlers } from "@amqp-contract/worker";
import { Config, type ConfigInvalid, type Env } from "@btravstack/config";
import {
  RuntimePort,
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/core";
import {
  Module,
  Port,
  Provider,
  type PortClassOf,
  type PortInstance,
  type ServiceOf,
} from "@btravstack/di";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

import { messageUnits } from "./message-units.js";

/** What the worker publishes once it is consuming, read back through `RunningApp.runtimeInfo()`. */
export type AmqpInfo = { readonly queues: readonly string[] };

/**
 * The broker, as a service: `amqp()` binds it from `AMQP_URL` (default
 * `amqp://127.0.0.1:5672`) unless pinned, and anything else in the graph may
 * read it — a publisher sharing the consumer's broker, say.
 */
export class AmqpConfig extends Port("AmqpConfig")<{ readonly url: string }> {}

/** The runtime's port: what `amqp()` provides, and what the module `start` boots must export. */
export class AmqpRuntime extends RuntimePort<Runtime<never, AmqpInfo>> {}

/**
 * The contract type `TypedAmqpWorker.create` accepts, extracted rather than
 * imported by name so `@amqp-contract/contract` stays out of the peer range.
 */
export type AnyAmqpContract = Parameters<typeof TypedAmqpWorker.create>[0]["contract"];

/**
 * The handlers' port — one id, the starter's own. A consumer serves one
 * handlers record as it boots one runtime, so the port is framework-owned
 * like `AmqpConfig`, and an application never names it:
 * `AmqpHandlers(contract)(deps, arm)` returns the provider that targets it.
 * Left generic at the value level (one `Port(...)` call, one id, no
 * duplicate-id warning however many contracts instantiate it) and fixed per
 * contract at the type level through `HandlersPortOf<C>` — the same move the
 * kernel's `RuntimePort` makes — so a provider built for one contract cannot
 * be handed to a module declaring another. Exported from this file for the
 * package's own tests, not from `index.ts`.
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

export type AmqpOptions<TContract extends AnyAmqpContract> = {
  /**
   * The contract; the handlers port is typed by it — one handler per
   * `consumers` / `rpcs` key, `WorkerInferHandlers<TContract>` with no
   * injected context (a handler is built by di from the services it declares,
   * so there is no context for the middleware to hand it) — and the
   * composition root provides it through `AmqpHandlers(contract)(deps, arm)`.
   */
  readonly contract: TContract;
  /** Pins the broker instead of reading `AMQP_URL` — a test's container. */
  readonly url?: string;
  readonly connectionOptions?: Record<string, unknown>;
  readonly defaultConsumerOptions?: Record<string, unknown>;
  /**
   * How long `create` waits for the connection before failing. Passed straight
   * through — it is a top-level `CreateWorkerOptions` field, NOT nested under
   * `connectionOptions`, where setting it is silently inert. Without it an
   * unreachable broker takes the library's 30s default to report.
   */
  readonly connectTimeoutMs?: number;
};

/**
 * The AMQP starter: a module providing the runtime (`AmqpRuntime`) and its
 * configuration (`AmqpConfig`, bound from `AMQP_URL` unless pinned here),
 * built over the handlers the application provides on the starter's own
 * handlers port (`AmqpHandlers(contract)(deps, arm)`). Import it next to the
 * application, provide the handlers, export `AmqpRuntime` — that is the whole
 * of the transport wiring. The handlers port is the module's one need, which
 * di's own gate checks where the composition root is declared.
 *
 * With `url` pinned the module reads nothing from the environment (the
 * declared `Env` need and `ConfigInvalid` stay — the kernel discharges the
 * one, a pinned config never produces the other).
 */
export const amqp = <TContract extends AnyAmqpContract>(
  options: AmqpOptions<TContract>,
): Module<AmqpRuntime | AmqpConfig, ConfigInvalid, Env | HandlersInstanceOf<TContract>> => {
  const config =
    options.url === undefined
      ? Config.provider(AmqpConfig)(
          Config.object({
            url: Config.string("AMQP_URL", { default: "amqp://127.0.0.1:5672" }),
          }),
        )
      : Provider(AmqpConfig)({ value: { url: options.url } });
  return Module("Amqp")({
    provides: [
      config,
      Provider(AmqpRuntime)([AmqpConfig, AmqpHandlersPort as HandlersPortOf<TContract>], {
        sync: (c, handlers): Runtime<never, AmqpInfo> => ({
          name: "amqp",
          needs: [],
          start: (host) => createWorker(host, c, options, handlers),
        }),
      }),
    ],
    exports: [AmqpRuntime, AmqpConfig],
  });
};

/**
 * The handlers as a provider, from the contract:
 * `AmqpHandlers(orderContract)([Logger], { sync: (logger) => ({ orderChanged:
 * (message) => … }) })` — each handler a plain function of the message its
 * consumer declares, typed by the contract, with nothing to wrap it in
 * (`WorkerInferHandlers<C>` accepts the bare function). The first call fixes
 * the contract and returns di's own `Provider(port)` on the starter's handlers
 * port typed for it — `WorkerInferHandlers<C>`, the one shape `amqp()`
 * accepts — so the second call is exactly what it is everywhere else: any
 * arm, same typing. There is no name to give: a consumer serves one handlers
 * record, so the port is the starter's, and the provider carries it typed
 * (`orderHandlers.port`) for whoever needs the class. The class line is what
 * disappears.
 */
export const AmqpHandlers = <C extends AnyAmqpContract>(
  _contract: C,
): ReturnType<typeof Provider<HandlersPortOf<C>>> =>
  Provider(AmqpHandlersPort as HandlersPortOf<C>);

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

const createWorker = <TContract extends AnyAmqpContract>(
  host: RuntimeHost<never>,
  config: ServiceOf<AmqpConfig>,
  options: AmqpOptions<TContract>,
  handlers: WorkerInferHandlers<TContract>,
): AsyncResult<Serving<AmqpInfo>, RuntimeStartFailed> =>
  TypedAmqpWorker.create({
    contract: options.contract,
    handlers,
    middleware: messageUnits(host),
    urls: [config.url],
    ...(options.connectionOptions === undefined
      ? {}
      : { connectionOptions: options.connectionOptions }),
    ...(options.defaultConsumerOptions === undefined
      ? {}
      : { defaultConsumerOptions: options.defaultConsumerOptions }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  })
    .map((worker) => consume(worker, queuesOf(options.contract)))
    // `create` reports a connection failure on the DEFECT channel with a
    // `TechnicalError` cause — never a modeled `Err`. This is the one place
    // where that is a *startup* failure rather than an unmodelled one, and
    // moving it back is what keeps `runMain`'s exit code 1 rather than 70.
    .recoverDefect((cause) => ErrAsync(startFailed(cause)));

const consume = (worker: TypedAmqpWorker<never>, queues: readonly string[]): Serving<AmqpInfo> => {
  // `close()` is the whole of this worker's shutdown — cancel every consumer,
  // drain in-flight handlers so their acks land on a still-open channel, then
  // close. Memoised because both methods reach it and the kernel calls `stop`
  // after `drain` on the signal path.
  //
  // The result is HELD, not dropped: `close()` can defect, and an empty error
  // channel is not an empty defect channel.
  let closing: AsyncResult<void, never> | undefined;
  const beginClose = (): AsyncResult<void, never> =>
    (closing ??= worker.close({ drainTimeoutMs: null }));

  // The kernel's deadline, kept from `drain` so `stop` is released by the same
  // abort. `drainTimeoutMs: null` is deliberate: the library's own
  // DEFAULT_DRAIN_TIMEOUT_MS is 30s and would sit ABOVE the kernel's 20s
  // default, quietly winning. One deadline in the process, and it is the
  // kernel's.
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

/**
 * `closing`, but no later than the kernel's drain deadline.
 *
 * `Serving.drain(signal)` is a contract, not a courtesy: the kernel aborts
 * `signal` the instant its own timeout wins, precisely so a runtime that treats
 * it as its cue to return can be released. A delivery whose handler never
 * finishes cannot honour that by waiting on `close()`, which settles on the
 * library's own drain clock rather than the kernel's.
 *
 * The losing branch's `Result` is dropped, and it is the one drop in this
 * package: when the deadline wins, the kernel has already decided the report
 * and settled `exited`, so the worker's eventual close has no consumer left —
 * and an `AsyncResult` never rejects, so nothing floats. Losing here is
 * cheaper than it is for `-temporal` or `-http`: the un-acked deliveries are
 * redelivered by the broker, so abandonment loses nothing and repeats
 * something — where an abandoned HTTP response is an answer nobody gets and an
 * abandoned Temporal activity is a platform retry. It is the same trade the
 * kernel's own `drainApp` documents for its race.
 */
const releasedBy = (
  signal: AbortSignal,
  closing: AsyncResult<void, never>,
): AsyncResult<void, never> =>
  fromSafePromise(Promise.race([closing, whenAborted(signal)])).flatMap((settled) => settled);

const whenAborted = (signal: AbortSignal): AsyncResult<void, never> =>
  signal.aborted
    ? OkAsync()
    : fromSafePromise(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
