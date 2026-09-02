import { ConfigInvalid } from "@btravstack/config";
import type { Module } from "@btravstack/di";
import { P } from "unthrown";

import { RuntimeStartFailed, type RuntimeInfoOf } from "./runtime.js";
import {
  start,
  type ExitReport,
  type RunningApp,
  type StartGate,
  type StartOptions,
} from "./start.js";

// sysexits(3): an internal software error, and a deployment that is wrong
// rather than code that is.
const EX_SOFTWARE = 70;
const EX_CONFIG = 78;

const isConfig = (error: unknown): boolean =>
  error instanceof ConfigInvalid ||
  (error instanceof RuntimeStartFailed && error.cause instanceof ConfigInvalid);

// The `uncaught` arm must come FIRST: both can be true of one report, and
// ordering it second reports `2` for a process that died.
const codeFor = (report: ExitReport): number => {
  if (report.reason === "uncaught") return EX_SOFTWARE;
  const unclean = (report.drain?.abandoned ?? 0) > 0 || report.teardownErrors.length > 0;
  return unclean ? 2 : 0;
};

/**
 * The exit-code half of `runMain`, on its own so the code table can be asserted
 * against hand-built reports without booting a kernel. Exported for
 * `run-main.spec.ts` only, not from `index.ts`.
 */
export const awaitExit = async <E>(
  // `RunningApp<E, unknown>`: only `exited` is read, and `Info` is covariant.
  app: RunningApp<E, unknown>,
  exit: (code: number) => void,
): Promise<void> => {
  const result = await app.exited;

  exit(
    result.match({
      ok: codeFor,
      // Every modeled startup failure means the same thing to the operating
      // system — the process never came up — except the one the operator can
      // fix in the deployment.
      // oxlint-disable-next-line unthrown/no-catch-all-pattern -- generic `E`: the catch-all is the only arm that can terminate a match over an unresolved type parameter
      errCases: (matcher) => matcher.with(P._, (error) => (isConfig(error) ? EX_CONFIG : 1)),
      defect: () => EX_SOFTWARE,
    }),
  );
};

/**
 * Boot a module and turn its outcome into a process exit code — the front
 * door, and the one sanctioned place this package decides a process's fate.
 * `start` composed with the wait for `exited`: use `start` instead when the
 * `RunningApp` itself is wanted (a test, an embedder, a dev runner booting
 * two applications — none of which may claim `process.exitCode`).
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
 * | a configuration port that could not be bound (`ConfigInvalid`, `PROBE_PORT` included) | `78` |
 * | drained with work abandoned | `2` |
 * | exited with teardown errors | `2` |
 * | stopped by an uncaught exception or unhandled rejection | `70` |
 * | a defect | `70` |
 *
 * The two `70`s are the same statement reached through the two channels a bug
 * can take. A crash takes precedence over abandoned work.
 *
 * @example
 * ```ts
 * // `OrderApi` imports the application next to `http()` and exports
 * // `HttpRuntime`. `PORT`, `HOST` and `PROBE_PORT` are read inside the graph.
 * await runMain(OrderApi);
 * ```
 */
// The one async surface here returning a bare `Promise<void>`: its whole job is
// to leave the Result world and become a process exit code.
export const runMain = async <X, E, N, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, N> & StartGate<X, UnitNeeds, N>,
  options: StartOptions<UnitX, UnitNeeds> = {},
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  // The gate proves the needs at the call site, and that proof is not visible
  // in a body where `X` is still a type parameter.
  const boot = start as unknown as (
    module: Module<X, E, N>,
    options: StartOptions<UnitX, UnitNeeds>,
  ) => RunningApp<E, RuntimeInfoOf<X>>;

  await awaitExit(boot(module, options), exit);
};
