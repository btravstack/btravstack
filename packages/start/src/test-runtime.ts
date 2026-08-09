import { Ok, type AsyncResult, type Result } from "unthrown";

import type { DrainReport } from "./drain-report.js";
import type { Runtime, RuntimeHost, Serving } from "./runtime.js";
import type { RunUnit } from "./runtime.js";

export type SubmittedUnit<T, E> = {
  readonly settle: (result: Result<T, E>) => void;
  readonly result: AsyncResult<T, E>;
  readonly signal: AbortSignal;
};

export type TestRuntime = Runtime<never> & {
  readonly started: () => boolean;
  readonly serving: () => Serving;
  readonly submit: <T = string, E = never>() => SubmittedUnit<T, E>;
};

export const testRuntime = (name = "test"): TestRuntime => {
  let run: RunUnit<never> | undefined;
  let accepting = false;
  let serving: Serving | undefined;
  let submitted = 0;
  let completed = 0;

  const make = (): Serving => ({
    drain: (signal) => {
      accepting = false;
      void signal;
      const report: DrainReport = {
        inFlightAtStart: submitted - completed,
        completed,
        abandoned: 0,
      };
      return Ok(report).toAsync();
    },
    stop: () => {
      accepting = false;
      return Ok(undefined).toAsync();
    },
  });

  return {
    name,
    needs: [],
    start: (host: RuntimeHost<never>) => {
      run = host.run;
      accepting = true;
      serving = make();
      return Ok(serving).toAsync();
    },
    started: () => serving !== undefined,
    serving: () => {
      if (serving === undefined) {
        // A test-only fixture: reaching here means the test forgot to start
        // the runtime, which is a bug in the test, not a modeled outcome.
        // (No `oxlint-disable` needed — `unthrown/no-throw` is opt-in and this
        // repo does not enable it; an unused disable directive is itself a
        // lint warning.)
        throw new Error("[test-runtime] not started");
      }
      return serving;
    },
    submit: <T, E>() => {
      if (run === undefined || !accepting) {
        // Same rationale as above: a test asserting post-drain behaviour wants
        // this to be loud, not routed.
        throw new Error("[test-runtime] not accepting work");
      }

      submitted += 1;
      let settle!: (result: Result<T, E>) => void;
      const held = new Promise<Result<T, E>>((resolve) => {
        settle = resolve;
      });
      let signal!: AbortSignal;

      const result = run<T, E>({ kind: "test", id: `${submitted}` }, async (_ctx, s) => {
        signal = s;
        const value = await held;
        completed += 1;
        return value;
      });

      return {
        settle,
        result,
        get signal() {
          return signal;
        },
      };
    },
  };
};
