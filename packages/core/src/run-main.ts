import type { Module, Scope } from "@btravstack/di";
import { P } from "unthrown";

import { ConfigInvalid, type Env } from "./config.js";
import { RuntimeStartFailed, type RuntimeInfoOf } from "./runtime.js";
import {
  start,
  type ExitReport,
  type RunningApp,
  type StartGate,
  type StartOptions,
} from "./start.js";

// sysexits(3)'s `EX_SOFTWARE`: an internal software error. A defect is exactly
// that — a failure nobody modelled — so it gets its own code rather than
// sharing `1` with a startup failure the operator can act on.
const EX_SOFTWARE = 70;
// sysexits(3)'s `EX_CONFIG`: the deployment is wrong, not the code. A
// configuration port that could not be bound — or the kernel's own
// `PROBE_PORT`, which arrives as a `RuntimeStartFailed` for `"probes"` with
// the `ConfigInvalid` as its cause — is the one startup failure an operator
// fixes without a rebuild, and the code says so.
const EX_CONFIG = 78;

const isConfig = (error: unknown): boolean =>
  error instanceof ConfigInvalid ||
  (error instanceof RuntimeStartFailed && error.cause instanceof ConfigInvalid);

// The precedence is deliberate and must stay explicit.
//
// An `"uncaught"` reason means the process died from an uncaught exception or
// an unhandled rejection. Installing a handler for either suppresses Node's own
// default exit code of `1` (see `uncaught.ts`), so if this returned `0` the
// kernel would report *success* to an orchestrator for a process that crashed —
// the exact opposite of what the uncaught path exists to signal. It is an
// internal software error, which is what `EX_SOFTWARE` names, so it shares the
// defect channel's code.
//
// A crash outranks abandoned work: both can be true of one report, and the
// crash is the more important fact about how the process died. In practice the
// uncaught path skips the drain entirely, so `drain` is `undefined` here — but
// the ordering is written out rather than left to depend on that.
//
// `2` is then the one code an operator reads as "we stopped, but not cleanly".
// Two facts make a shutdown unclean, and both belong here: the drain ran out of
// time and some work never finished, OR a finaliser failed on the way out. The
// second is not cosmetic — a pool that could not flush is exactly the shutdown
// an orchestrator must not be told succeeded — and the kernel already goes to
// real trouble to keep those errors observable (the load-bearing array aliasing
// in `start.ts`), which reporting `0` over them would waste.
//
// A clean drain with clean teardown, or no drain at all, is a `0`.
const codeFor = (report: ExitReport): number => {
  if (report.reason === "uncaught") return EX_SOFTWARE;
  const unclean = (report.drain?.abandoned ?? 0) > 0 || report.teardownErrors.length > 0;
  return unclean ? 2 : 0;
};

/**
 * The exit-code half of `runMain`, on its own so the code table can be
 * asserted against hand-built reports without booting a kernel. Exported for
 * `run-main.spec.ts` only — not part of the public surface (`index.ts` does
 * not re-export it). An embedder that will not use `runMain` folds
 * `ExitReport` into a code itself; this is not the API for that, the README's
 * embedding section is.
 */
export const awaitExit = async <E>(
  // `RunningApp<E, unknown>`, not `RunningApp<E>`: only `exited` is read, and
  // `Info` is covariant, so this accepts an app whose runtime publishes
  // anything at all.
  app: RunningApp<E, unknown>,
  exit: (code: number) => void,
): Promise<void> => {
  const result = await app.exited;

  exit(
    result.match({
      ok: codeFor,
      // `E` is the application's own error type, still unresolved here, so no
      // arm list can prove exhaustiveness against it and the catch-all is the
      // only arm that can terminate the match — the generic-`E` case the
      // wildcard is kept for. Every modeled startup failure means the same
      // thing to the operating system anyway — the process never came up —
      // except the one the operator can fix in the deployment.
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
 * The two `70`s are the same statement — sysexits(3)'s `EX_SOFTWARE`, an
 * internal software error — reached through the two channels a bug can take.
 * A crash takes precedence over abandoned work. `78` is `EX_CONFIG`: the
 * deployment is wrong, not the code.
 *
 * @example
 * ```ts
 * // `OrderApi` imports the application next to `@btravstack/http`'s `http()`
 * // starter and exports `HttpRuntime` — the port `start` resolves the runtime
 * // from. `PORT`, `HOST` and `PROBE_PORT` are read inside the graph.
 * await runMain(OrderApi);
 * ```
 */
// The one async surface in this package that returns a bare `Promise<void>`
// rather than an `AsyncResult`, deliberately: its whole job is to LEAVE the
// Result world and become a process exit code. It is the boundary, and a
// top-level `await runMain(...)` in an entry point is the intended shape.
export const runMain = async <X, E, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, Scope | Env>,
  options: StartOptions<UnitX, UnitNeeds> = {},
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
  // The same phantom gate `start` carries, for the same reason: it makes the
  // runtime's declared needs a compile-time check at *this* call site.
  ...gate: StartGate<X, UnitX, UnitNeeds>
): Promise<void> => {
  void gate;

  // The gate above proves the needs at the call site, but that proof is not
  // visible inside a body where `X` is still an unresolved type parameter —
  // the same reason `withApp` discharges the tuple the same way.
  const boot = start as (
    module: Module<X, E, Scope | Env>,
    options: StartOptions<UnitX, UnitNeeds>,
  ) => RunningApp<E, RuntimeInfoOf<X>>;

  await awaitExit(boot(module, options), exit);
};
