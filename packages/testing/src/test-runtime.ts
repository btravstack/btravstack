import {
  RuntimePort,
  type AnyUnitModule,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitNeedsOf,
} from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
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

export type TestRuntimeOptions<Unit extends AnyUnitModule | undefined = undefined> = {
  /** A module every submitted unit forks, with no seed, before its work runs. */
  readonly unit?: Unit;
};

export type TestRuntime<Unit extends AnyUnitModule | undefined = undefined> = Runtime<
  never,
  TestRuntimeInfo
> & {
  /**
   * A module providing this very runtime on `TestRuntimePort`: import it next
   * to the module under test, export the port, and `start` finds it.
   *
   * It provides THIS object, so a wrapper built by spreading copies the module
   * too and that module still boots the inner runtime — a wrapper needs a module
   * of its own.
   *
   * Its Needs channel carries a bound `unit` module's own unmet needs, though
   * nothing here reads them: the module is forked over the application context
   * per unit, so what it needs is exactly what the test composition must
   * supply — and this is what makes `start`'s `UNSATISFIED DEPENDENCIES` say so
   * at boot instead of leaving a `WiringDefect` for the first `submit()`.
   */
  readonly module: Module<TestRuntimePort, never, UnitNeedsOf<Unit>>;
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
  /** The `RuntimeHost` the kernel last called `start` with. **Throws** if the runtime was never started — the same misuse guard as `serving()`. */
  readonly host: () => RuntimeHost<never>;
};

export const testRuntime = <Unit extends AnyUnitModule | undefined = undefined>(
  name = "test",
  options: TestRuntimeOptions<Unit> = {},
): TestRuntime<Unit> => {
  let host: RuntimeHost<never> | undefined;
  let accepting = false;
  let serving: Serving<TestRuntimeInfo> | undefined;
  let submitted = 0;
  const started = Promise.withResolvers<void>();
  // Ignores `drain`'s deadline signal on purpose: the kernel's own abort is
  // what a test of the drain observes.
  const stopAccepting = (): AsyncResult<void, never> => {
    accepting = false;
    return OkAsync();
  };

  const runtime: TestRuntime<Unit> = {
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
      serving = { info: { name }, drain: stopAccepting, stop: stopAccepting };
      started.resolve();
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
      const held = Promise.withResolvers<Result<T, E>>();
      // Forwarded rather than captured: the work runs only once the fork is
      // built, so a captured signal would be `undefined` for a caller reading
      // it right after `submit()`.
      const forwarded = new AbortController();
      const unit = options.unit;
      const result = host.run<T, E>({ kind: "test", id: `${submitted}` }, (unitHost, signal) => {
        if (signal.aborted) forwarded.abort(signal.reason);
        else signal.addEventListener("abort", () => forwarded.abort(signal.reason), { once: true });
        return unit === undefined
          ? held.promise
          : // `as never`: the same cast `@btravstack/http-server`'s `htmx.ts`
            // carries. `AnyUnitModule` erases Needs to `unknown`, which
            // `fork`'s own `DependencyGate` can never clear; what the module
            // owes rides `TestRuntime.module`'s Needs channel instead, where
            // `start` checks it against the composition root.
            unitHost
              .fork(unit as never, [])
              .flatMap(() => fromSafePromise(held.promise).flatMap((r) => r));
      });

      return { settle: held.resolve, result, signal: forwarded.signal };
    },
  };

  return runtime;
};
