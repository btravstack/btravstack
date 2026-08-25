import { Port, type AnyPort, type Context, type PortClass, type ServiceOf } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

import type { UnitMeta, UnitWork } from "./units.js";

export class RuntimeStartFailed extends TaggedError("RuntimeStartFailed")<{
  readonly runtime: string;
  readonly cause: unknown;
}> {
  override message = `the ${this.runtime} runtime failed to start`;
}

/**
 * Submit one piece of work as a **unit**: the kernel counts it towards the
 * drain, hands it an `AbortSignal` and an ambient record, and gives the work's
 * own `Result` straight back — mapping that outcome to a transport is the
 * runtime's job, never the kernel's.
 *
 * @remarks
 * **Everything the client must receive has to be flushed INSIDE `work`, never
 * after the returned `AsyncResult` settles.** A unit closes the instant its
 * `Result` settles, and an idle registry is the drain's permission to call
 * `Serving.stop()` — so a runtime that writes after resolving is racing the
 * transport being torn down.
 *
 * `UnitMeta.id` must be unique per unit unless a `traceId` is supplied — see
 * {@link UnitMeta}.
 *
 * With a `StartOptions.unit` module in play, `work` runs only once the fork is
 * built. A runtime that subscribes to an event from inside `work` must first
 * check whether it has already fired.
 */
// `Context<InstanceType<Resolves>>`, not `Context<Resolves>`: di parameterises
// `Context<in R>` by port instance types, while a runtime declares what it
// resolves as port classes.
export type RunUnit<Resolves extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (ctx: Context<InstanceType<Resolves>>, signal: AbortSignal) => ReturnType<UnitWork<T, E>>,
) => AsyncResult<T, E>;

/**
 * What a runtime is handed at `start`: the application services **and** the
 * kernel's {@link RunUnit}. Handing it a bare `Context` would leave every
 * runtime inventing its own unit tracking — the thing the kernel exists to own.
 *
 * @remarks
 * The two contracts a runtime author owes, neither checkable by the kernel: a
 * unit's response must be flushed **inside** the work callback (see
 * {@link RunUnit}), and `UnitMeta.id` must be unique per unit unless a
 * `traceId` is supplied (see {@link UnitMeta}).
 *
 * `ctx` is the **application** context: a port a `StartOptions.unit` module
 * provides exists only while a unit is open, so a runtime naming it in
 * `resolves` is rejected at `start`'s call site.
 */
export type RuntimeHost<Resolves extends AnyPort> = {
  readonly ctx: Context<InstanceType<Resolves>>;
  readonly run: RunUnit<Resolves>;
};

/**
 * What a runtime is, once it is up — plus, optionally, what it wants to say
 * about itself, read back through `RunningApp.runtimeInfo()`.
 *
 * `Info` is the runtime's own shape rather than a port number: a queue consumer
 * has no port and might publish `{ queue, prefetch }`. It defaults to `never`,
 * so `info` is unwritable for a runtime with nothing to publish.
 */
export type Serving<Info = never> = {
  // `void`, not a `DrainReport`: only the kernel can see the unit registry, so
  // it owns the accounting. `drain` means "stop accepting".
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
  readonly info?: Info;
};

export type Runtime<Resolves extends AnyPort = never, Info = never> = {
  readonly name: string;
  // `resolves`, not `needs`: a module's `needs` is what a composition root
  // supplies it, this is what the runtime reads back out of the built
  // application context. Never read at run time — it exists so `Resolves` is
  // inferable from the value.
  readonly resolves: readonly Resolves[];
  readonly start: (host: RuntimeHost<Resolves>) => AsyncResult<Serving<Info>, RuntimeStartFailed>;
};

/**
 * The port the kernel resolves its runtime from. A runtime is a **service the
 * module provides**, not an option handed to `start`: a runtime package
 * declares its own port over this one — `class HttpRuntime extends
 * RuntimePort<Runtime<never, HttpInfo>> {}` — so it is built by di like
 * everything else, and the kernel owns nothing but the lifecycle.
 *
 * Left generic on purpose: every runtime port is one id at runtime, since a
 * process boots exactly one, while each carries its own `Resolves`/`Info` in
 * the type.
 */
export const RuntimePort = Port("Runtime");

/** The instance type every runtime port shares — `Extract` this from a module's exports to find its runtime. */
export type RuntimeInstance = InstanceType<PortClass<"Runtime">>;

/** The `Runtime<Resolves, Info>` a module exports, or `never` when it exports none. */
export type RuntimeOf<X> = ServiceOf<Extract<X, RuntimeInstance>>;

export type RuntimeResolvesOf<X> =
  RuntimeOf<X> extends Runtime<infer Resolves, unknown> ? Resolves : never;

export type RuntimeInfoOf<X> = RuntimeOf<X> extends Runtime<AnyPort, infer Info> ? Info : never;
