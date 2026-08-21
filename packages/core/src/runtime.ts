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
 * after the returned `AsyncResult` settles.** A unit is closed the instant its
 * `Result` settles; an idle registry is what the drain waits for, and going
 * idle is its permission to call `Serving.stop()`. A runtime that resolves the
 * unit and *then* writes its response is racing `stop()` tearing the transport
 * down — with a small body the write usually wins, and with a large one it does
 * not (measured with an 8 MB body: `UND_ERR_SOCKET: other side closed`). A unit
 * is not "compute the answer", it is "compute the answer **and get it out of
 * the process**".
 *
 * `UnitMeta.id` must be unique per unit unless a `traceId` is supplied — see
 * {@link UnitMeta}.
 *
 * With a `StartOptions.unit` module in play, `work` runs only once the fork is
 * built — after an `await` when a unit provider is async — not synchronously
 * inside `host.run`. A runtime that subscribes to an event from inside `work`
 * (a response's `'close'`) must first check whether it has already fired.
 */
// `Context<InstanceType<Needs>>`, not `Context<Needs>`: di parameterises
// `Context<in R>` by port *instance* types, while a runtime declares what it
// resolves as port *classes* (`AnyPort` is `abstract new () => AnyPortInstance`).
// `InstanceType<never>` is `never`, so a runtime resolving nothing is unaffected.
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
 * The two contracts a runtime author owes, both easy to miss and neither
 * checkable by the kernel: a unit's response must be flushed **inside** the
 * work callback (see {@link RunUnit}), and `UnitMeta.id` must be unique per
 * unit unless a `traceId` is supplied (see {@link UnitMeta}).
 *
 * `ctx` is the **application** context, and `start`'s gate checks a
 * runtime's `resolves` against the application module's exports only — a port a
 * `StartOptions.unit` module provides exists only while a unit is open, and a
 * runtime naming it there is rejected at the call site rather than left
 * to `ctx.get(...)` throwing at startup.
 */
export type RuntimeHost<Resolves extends AnyPort> = {
  readonly ctx: Context<InstanceType<Resolves>>;
  readonly run: RunUnit<Resolves>;
};

/**
 * What a runtime is, once it is up — plus, optionally, what it wants to say
 * about itself.
 *
 * `Info` is the runtime's own shape and is deliberately **not** modelled as a
 * port number: a runtime that binds `port: 0` publishing `{ port }` is the
 * motivating case, but a queue consumer has no port and might publish
 * `{ queue, prefetch }`. It defaults to `never`, so `info` is unwritable and
 * `Serving` reads exactly as it did for every runtime with nothing to publish.
 * The caller reads it back through `RunningApp.runtimeInfo()`.
 */
export type Serving<Info = never> = {
  // Returns `void`, not a `DrainReport`: only the kernel can see the unit
  // registry, so it — not the runtime — owns the accounting. `drain` tells
  // the runtime to stop accepting new work; the kernel decides what counts as
  // completed vs. abandoned once its own deadline passes.
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
  readonly info?: Info;
};

export type Runtime<Resolves extends AnyPort = never, Info = never> = {
  readonly name: string;
  // `resolves`, not `needs`: di's `Module` has a `needs` of its own and the two
  // are different obligations — a module's is what a composition root supplies
  // it, this is what the runtime reads back out of the built application
  // context. The array is never read at run time; it exists so `Resolves` is
  // inferable from the value, and `start`'s gate checks it against the
  // module's exports.
  readonly resolves: readonly Resolves[];
  readonly start: (host: RuntimeHost<Resolves>) => AsyncResult<Serving<Info>, RuntimeStartFailed>;
};

/**
 * The port the kernel resolves its runtime from. A runtime is a **service the
 * module provides**, not an option handed to `start`: a runtime package
 * declares its own port over this one — `class HttpRuntime extends
 * RuntimePort<Runtime<never, HttpInfo>> {}` — and ships a module
 * providing it, so the runtime is built by di like everything else and reads
 * its collaborators the same way. The kernel then owns nothing but the graph's
 * lifecycle: it builds the module, resolves this port, and drives what it
 * finds through `start` → `serving` → `drain` → `stop`.
 *
 * Left generic on purpose (`Port("Runtime")` without a fixed service): every
 * runtime port is one id at runtime — a process boots exactly one — while each
 * carries its own `Needs`/`Info` in the type, which is what `start`'s gate and
 * `RunningApp.runtimeInfo()` read back out of the module's exports.
 */
export const RuntimePort = Port("Runtime");

/** The instance type every runtime port shares — `Extract` this from a module's exports to find its runtime. */
export type RuntimeInstance = InstanceType<PortClass<"Runtime">>;

/** The `Runtime<Needs, Info>` a module exports, or `never` when it exports none. */
export type RuntimeOf<X> = ServiceOf<Extract<X, RuntimeInstance>>;

export type RuntimeResolvesOf<X> =
  RuntimeOf<X> extends Runtime<infer Resolves, unknown> ? Resolves : never;

export type RuntimeInfoOf<X> = RuntimeOf<X> extends Runtime<AnyPort, infer Info> ? Info : never;
