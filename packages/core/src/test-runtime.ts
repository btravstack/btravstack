import { Module, Provider } from "@btravstack/di";
import { OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { createDeferred } from "./deferred.js";
import { RuntimePort, type Runtime, type RuntimeHost, type Serving } from "./runtime.js";
import type { RunUnit } from "./runtime.js";

export type SubmittedUnit<T, E> = {
  readonly settle: (result: Result<T, E>) => void;
  readonly result: AsyncResult<T, E>;
  readonly signal: AbortSignal;
};

/**
 * What `testRuntime` publishes on `Serving.info` — its own name, the one thing
 * an in-memory runtime genuinely knows about itself. A real runtime publishes
 * its own shape (an HTTP one, a bound `port`); this exists so the mechanism is
 * exercised end to end by the suite.
 */
export type TestRuntimeInfo = { readonly name: string };

/** The in-memory runtime's port: what `TestRuntime.module` provides, and what a test composition exports. */
export class TestRuntimePort extends RuntimePort<Runtime<never, TestRuntimeInfo>> {}

export type TestRuntime = Runtime<never, TestRuntimeInfo> & {
  /**
   * A module providing this very runtime on `TestRuntimePort` — the shape a
   * runtime package ships (`@btravstack/http`'s `http()`), sized for a test: import it
   * next to the module under test and export the port, and `start` finds it.
   *
   * It provides **this** object. A wrapper built by spreading (`{ ...runtime,
   * start }`) copies the module too, so its module still boots the inner,
   * unwrapped runtime — a wrapper provides itself on `TestRuntimePort` with a
   * module of its own.
   */
  readonly module: Module<TestRuntimePort, never, never>;
  readonly started: () => boolean;
  /** Resolves the first time the kernel calls `start` — `start` itself stays pending until shutdown. */
  readonly untilStarted: () => AsyncResult<void, never>;
  /**
   * Whether the runtime would still take new work — false once `drain` or
   * `stop` has been called. Lets a test observe *when* the kernel told the
   * runtime to stop accepting, which the drain's ordering invariant turns on.
   */
  readonly accepting: () => boolean;
  readonly serving: () => Serving<TestRuntimeInfo>;
  readonly submit: <T = string, E = never>() => SubmittedUnit<T, E>;
};

export const testRuntime = (name = "test"): TestRuntime => {
  let run: RunUnit<never> | undefined;
  let accepting = false;
  let serving: Serving<TestRuntimeInfo> | undefined;
  let submitted = 0;
  const started = createDeferred<void>();

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

  const runtime: TestRuntime = {
    name,
    module: Module("TestRuntime")({
      // Resolved lazily so the object literal can name itself.
      provides: [Provider(TestRuntimePort)({ sync: () => runtime })],
      exports: [TestRuntimePort],
    }),
    needs: [],
    start: (host: RuntimeHost<never>) => {
      run = host.run;
      accepting = true;
      serving = make();
      started.resolve(undefined);
      return OkAsync(serving);
    },
    started: () => serving !== undefined,
    untilStarted: () => fromSafePromise(started.promise),
    accepting: () => accepting,
    serving: () => {
      if (serving === undefined) {
        // oxlint-disable-next-line unthrown/no-throw -- a test-only fixture: reaching here means the test forgot to start the runtime, which is a bug in the test rather than a modeled outcome, so it must be loud and not routed into a `Result` a careless assertion could swallow
        throw new Error("[test-runtime] not started");
      }
      return serving;
    },
    submit: <T, E>() => {
      if (run === undefined || !accepting) {
        // oxlint-disable-next-line unthrown/no-throw -- same rationale as `serving()` above: a test asserting post-drain behaviour wants this loud, not routed
        throw new Error("[test-runtime] not accepting work");
      }

      submitted += 1;
      let settle!: (result: Result<T, E>) => void;
      const held = new Promise<Result<T, E>>((resolve) => {
        settle = resolve;
      });
      // Forwarded rather than captured: with a `unit` module the kernel runs
      // the work only once the fork is built, so a captured signal would be
      // `undefined` for a caller reading it right after `submit()`.
      const forwarded = new AbortController();
      const result = run<T, E>({ kind: "test", id: `${submitted}` }, (_ctx, signal) => {
        if (signal.aborted) forwarded.abort(signal.reason);
        else signal.addEventListener("abort", () => forwarded.abort(signal.reason), { once: true });
        return held;
      });

      return { settle, result, signal: forwarded.signal };
    },
  };

  return runtime;
};
