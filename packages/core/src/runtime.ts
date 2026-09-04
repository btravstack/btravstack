import {
  Port,
  type AnyPort,
  type Context,
  type DependencyGate,
  type Module,
  type PortClass,
  type Scope,
  type SeedEntry,
  type ServiceOf,
} from "@btravstack/di";
import { OkAsync, TaggedError, fromSafePromise, type AsyncResult } from "unthrown";

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
 * A runtime forks the unit's scope itself, through `UnitHost.fork`, at the
 * moment it holds the unit's input; the kernel closes that scope when the
 * unit settles, after the response is flushed. Work that subscribes to an
 * event after a `fork` must first check whether it already fired.
 */
// `Context<InstanceType<Resolves>>`, not `Context<Resolves>`: di parameterises
// `Context<in R>` by port instance types, while a runtime declares what it
// resolves as port classes.
export type RunUnit<Resolves extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (unit: UnitHost<Resolves>, signal: AbortSignal) => ReturnType<UnitWork<T, E>>,
) => AsyncResult<T, E>;

/**
 * What the kernel hands a unit's work: the application context, and the one
 * way to open the unit's own scope.
 *
 * `fork` builds `module` over the application context plus `seed` and hands
 * the forked context back. The scope is torn down when the unit closes —
 * inside the registry's unit, so the unit is not counted closed until its
 * finalisers have run, and inside the unit's ambient record, so a teardown
 * log line carries the unit's ids. A construction failure rides the unit's
 * defect path. A unit forks once; a second call is a defect, and so is a call
 * made after the unit has settled — nothing awaits that scope's teardown.
 */
export type UnitHost<Resolves extends AnyPort> = {
  readonly ctx: Context<InstanceType<Resolves>>;
  readonly fork: <UnitX, N, Seeded extends AnyPort = never>(
    module: Module<UnitX, never, N> &
      DependencyGate<Exclude<N, InstanceType<Resolves> | InstanceType<Seeded> | Scope>>,
    seed: readonly SeedEntry<Seeded>[],
  ) => AsyncResult<Context<InstanceType<Resolves> | UnitX | InstanceType<Seeded>>, never>;
};

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
 * `ctx` is the **application** context: a port a unit's `fork` module provides
 * exists only in the `Context` `fork` hands back, so a runtime naming it in
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

// Read field by field, not `RuntimeOf<X> extends Runtime<…>`: an alias match
// compares every parameter at once and stops inferring `Info` for a
// `never`-Resolves runtime.
export type RuntimeResolvesOf<X> =
  RuntimeOf<X> extends { readonly resolves: readonly (infer Resolves extends AnyPort)[] }
    ? Resolves
    : never;

export type RuntimeInfoOf<X> =
  RuntimeOf<X> extends {
    readonly start: (host: never) => AsyncResult<Serving<infer Info>, RuntimeStartFailed>;
  }
    ? Info
    : never;

/**
 * The trace id inside a W3C `traceparent` header, and nothing else of it.
 *
 * @remarks
 * The parent's **span id is dropped**, deliberately: `UnitMeta.traceId` is a
 * correlation id rather than a span context, and half-carrying one would
 * suggest a parent-child link nothing here maintains.
 *
 * Three things the specification calls invalid are refused like a malformed
 * header, because adopting one would replace a runtime's own usable id with a
 * value that means nothing: an **all-zero trace id**, an **all-zero parent
 * id** (the header is well-formed and names no span), and **version `ff`**,
 * which is reserved and never a version a caller may send.
 *
 * It is here rather than in a runtime because **every** transport carrying an
 * inbound trace needs the same answer, and two copies of a parser is two
 * places for the all-zero rule to be forgotten. A runtime pairs it with the
 * adopt-only-a-non-blank-inbound-id rule its own headers need:
 * `UnitMeta.traceId` defaults to `meta.id` when it is nullish and `""` is not,
 * so an empty header would hand a caller's every unit the same blank id.
 *
 * @example
 * ```ts
 * const parent = request.headers["traceparent"];
 * const traceId = typeof parent === "string" ? traceIdOfTraceparent(parent) : undefined;
 * ```
 */
export const traceIdOfTraceparent = (header: string): string | undefined => {
  // `(?!ff)` refuses the reserved version at the point it is read, rather than
  // leaving a second test to remember. The trailing group is what a future
  // version may append; `00` is the one version that must not carry it.
  const match = /^(?!ff)([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}(-.*)?$/.exec(
    header.trim(),
  );
  const [, version, traceId, parentId, extra] = match ?? [];
  if (traceId === undefined || parentId === undefined) return undefined;
  if (version === "00" && extra !== undefined) return undefined;
  return /^0+$/.test(traceId) || /^0+$/.test(parentId) ? undefined : traceId;
};

/**
 * `running`, but no later than the kernel's drain deadline — the primitive a
 * `Serving.drain` needs when the work it awaits settles on somebody else's
 * clock (Temporal's `shutdownForceTime`, a broker library's close) and so
 * cannot honour `signal` itself.
 *
 * **The losing branch's `Result` is dropped**, which is the point rather than
 * an oversight: once the deadline wins, the kernel has already moved on and
 * the eventual outcome has no consumer left. What that costs is the runtime's
 * own business — an un-acked AMQP delivery is redelivered, so abandoning one
 * repeats work rather than losing it, while a Temporal activity is retried on
 * another worker.
 *
 * Deliberately **`Clock`-agnostic**: there is no duration here, only a signal,
 * so it behaves identically under `@btravstack/testing`'s fake clock. Racing
 * work against a *timeout* is a different primitive and belongs on `Clock`
 * (`drain.ts` uses `clock.sleep` for exactly that, so a fake clock can control
 * it) — do not fold the two together.
 */
export const releasedBy = (
  signal: AbortSignal,
  running: AsyncResult<void, never>,
): AsyncResult<void, never> =>
  fromSafePromise(Promise.race([running, whenAborted(signal)])).flatMap((settled) => settled);

// Not exported: `releasedBy` is the whole use case, and an unqualified "wait
// for this signal" invites the `Clock`-shaped confusion the TSDoc above warns
// off. The already-aborted arm matters — `addEventListener` on an aborted
// signal never fires, so without it the race would hang forever.
const whenAborted = (signal: AbortSignal): AsyncResult<void, never> =>
  signal.aborted
    ? OkAsync()
    : fromSafePromise(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
