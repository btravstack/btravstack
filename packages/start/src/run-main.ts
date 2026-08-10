import { P } from "unthrown";

import type { ExitReport, RunningApp } from "./start.js";

// sysexits(3)'s `EX_SOFTWARE`: an internal software error. A defect is exactly
// that — a failure nobody modelled — so it gets its own code rather than
// sharing `1` with a startup failure the operator can act on.
const EX_SOFTWARE = 70;

// `2` is the one code an operator reads as "we stopped, but not cleanly": the
// drain ran out of time and some work never finished. A clean drain, or no
// drain at all, is a `0`.
const codeFor = (report: ExitReport): number => ((report.drain?.abandoned ?? 0) > 0 ? 2 : 0);

/**
 * Wait for an application to exit and turn its outcome into a process exit
 * code — the one sanctioned place this package decides a process's fate.
 *
 * `exit` is injectable and defaults to setting `process.exitCode`: `runMain`
 * never calls `process.exit()`, so pending output is flushed, an embedding
 * host keeps control of its own lifetime, and a test can observe the code
 * without ending the run.
 *
 * | outcome | code |
 * | --- | --- |
 * | exited cleanly | `0` |
 * | startup failure (a modeled `Err`) | `1` |
 * | drained with work abandoned | `2` |
 * | a defect | `70` |
 *
 * @example
 * ```ts
 * await runMain(start(AppModule, { runtime: httpRuntime }));
 * ```
 */
export const runMain = async <E>(
  app: RunningApp<E>,
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  const result = await app.exited;

  exit(
    result.match({
      ok: codeFor,
      // `E` is the application's own error type, still unresolved here, so no
      // arm list can prove exhaustiveness against it and the catch-all is the
      // only arm that can terminate the match — the generic-`E` case the
      // wildcard is kept for. Every modeled startup failure means the same
      // thing to the operating system anyway: the process never came up.
      // oxlint-disable-next-line unthrown/no-catch-all-pattern -- generic `E`: the catch-all is the only arm that can terminate a match over an unresolved type parameter
      errCases: (matcher) => matcher.with(P._, () => 1),
      defect: () => EX_SOFTWARE,
    }),
  );
};
