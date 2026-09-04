import { RuntimePort, type Runtime, type RuntimeHost, type Serving } from "@btravstack/core";
import { Module, Provider, type Scope } from "@btravstack/di";
import { OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

export type SubmittedUnit<T, E> = {
  readonly settle: (result: Result<T, E>) => void;
  readonly result: AsyncResult<T, E>;
  readonly signal: AbortSignal;
};

/**
 * What `testRuntime` publishes on `Serving.info` — its own name, the one thing
 * an in-memory runtime genuinely knows about itself.
 */
export type TestRuntimeInfo = { readonly name: string };

/** The in-memory runtime's port: what `TestRuntime.module` provides, and what a test composition exports. */
export class TestRuntimePort extends RuntimePort<Runtime<never, TestRuntimeInfo>> {}

export type TestRuntimeOptions = {
  /** A module every submitted unit forks, with no seed, before its work runs. */
  readonly unit?: Module<never, never, unknown>;
};

/**
 * What `TestRuntimeOptions.unit` needs, `Scope` aside — `never` when no module
 * was bound.
 *
 * The pattern's own `Exports` is `never`, not `unknown`: `Module`'s `Exports`
 * channel is contravariant, so a concrete module — `Module<Span, never,
 * Parent>`, say — matches a `never`-Exports pattern (`never` is assignable to
 * anything) and never an `unknown`-Exports one.
 */
type UnitNeedsOf<U> = U extends Module<never, never, infer N> ? Exclude<N, Scope> : never;

export type TestRuntime<UnitNeeds = never> = Runtime<never, TestRuntimeInfo, UnitNeeds> & {
  /**
   * A module providing this very runtime on `TestRuntimePort`: import it next
   * to the module under test, export the port, and `start` finds it.
   *
   * It provides THIS object, so a wrapper built by spreading copies the module
   * too and that module still boots the inner runtime — a wrapper needs a module
   * of its own.
   */
  readonly module: Module<TestRuntimePort, never, never>;
  readonly started: () => boolean;
  /** Resolves the first time the kernel calls `start` — `start` itself stays pending until shutdown. */
  readonly untilStarted: () => AsyncResult<void, never>;
  /**
   * Whether the runtime would still take new work — false once `drain` or
   * `stop` has been called, so a test can observe WHEN the kernel told it to
   * stop accepting.
   */
  readonly accepting: () => boolean;
  readonly serving: () => Serving<TestRuntimeInfo>;
  readonly submit: <T = string, E = never>() => SubmittedUnit<T, E>;
  /** The `RuntimeHost` the kernel last called `start` with — `undefined` before then. */
  readonly host: () => RuntimeHost<never>;
};

export const testRuntime = <U extends Module<never, never, unknown> | undefined = undefined>(
  name = "test",
  options: { readonly unit?: U } = {},
): TestRuntime<UnitNeedsOf<U>> => {
  let host: RuntimeHost<never> | undefined;
  let accepting = false;
  let serving: Serving<TestRuntimeInfo> | undefined;
  let submitted = 0;
  let onStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });

  const make = (): Serving<TestRuntimeInfo> => ({
    info: { name },
    drain: (signal) => {
      accepting = false;
      void signal;
      return OkAsync();
    },
    stop: () => {
      accepting = false;
      return OkAsync();
    },
  });

  const runtime: TestRuntime<UnitNeedsOf<U>> = {
    name,
    module: Module("TestRuntime")({
      // Resolved lazily so the object literal can name itself.
      provides: [Provider(TestRuntimePort)({ inject: {}, sync: () => runtime })],
      exports: [TestRuntimePort],
    }),
    resolves: [],
    start: (h: RuntimeHost<never>) => {
      host = h;
      accepting = true;
      serving = make();
      onStarted();
      return OkAsync(serving);
    },
    started: () => serving !== undefined,
    untilStarted: () => fromSafePromise(started),
    accepting: () => accepting,
    serving: () => {
      if (serving === undefined) {
        // oxlint-disable-next-line unthrown/no-throw -- a test-only fixture: reaching here means the test forgot to start the runtime, which is a bug in the test rather than a modeled outcome, so it must be loud and not routed into a `Result` a careless assertion could swallow
        throw new Error("[test-runtime] not started");
      }
      return serving;
    },
    host: () => {
      if (host === undefined) {
        // oxlint-disable-next-line unthrown/no-throw -- same rationale as `serving()` above: a test asserting post-drain behaviour wants this loud, not routed
        throw new Error("[test-runtime] not started");
      }
      return host;
    },
    submit: <T, E>() => {
      if (host === undefined || !accepting) {
        // oxlint-disable-next-line unthrown/no-throw -- same rationale as `serving()` above: a test asserting post-drain behaviour wants this loud, not routed
        throw new Error("[test-runtime] not accepting work");
      }

      submitted += 1;
      let settle!: (result: Result<T, E>) => void;
      const held = new Promise<Result<T, E>>((resolve) => {
        settle = resolve;
      });
      // Forwarded rather than captured: the work runs only once the fork is
      // built, so a captured signal would be `undefined` for a caller reading
      // it right after `submit()`.
      const forwarded = new AbortController();
      const unit = options.unit;
      const result = host.run<T, E>({ kind: "test", id: `${submitted}` }, (unitHost, signal) => {
        if (signal.aborted) forwarded.abort(signal.reason);
        else signal.addEventListener("abort", () => forwarded.abort(signal.reason), { once: true });
        return unit === undefined
          ? held
          : unitHost.fork(unit as never, []).flatMap(() => fromSafePromise(held).flatMap((r) => r));
      });

      return { settle, result, signal: forwarded.signal };
    },
  };

  return runtime;
};
