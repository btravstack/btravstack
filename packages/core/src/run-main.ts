import { ConfigInvalid, type Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
import { P } from "unthrown";

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

// The `uncaught` arm must come FIRST: a crash outranks abandoned work, both
// can be true of one report, and ordering it second would report `2` for a
// process that died. A failed finaliser earns the `2` as much as abandoned
// work does — the kernel goes to real trouble to keep those observable
// (`start.ts`'s array aliasing), which reporting `0` over them would waste.
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
  // The same phantom gate `start` carries, for the same reason: it makes the
  // runtime's declared `resolves` a compile-time check at *this* call site.
  module: Module<X, E, Scope | Env> & StartGate<X, UnitNeeds>,
  options: StartOptions<UnitX, UnitNeeds> = {},
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  // The gate above proves the needs at the call site, but that proof is not
  // visible inside a body where `X` is still an unresolved type parameter —
  // the same discharged-signature cast `bootFixture` makes, for the same reason.
  const boot = start as (
    module: Module<X, E, Scope | Env>,
    options: StartOptions<UnitX, UnitNeeds>,
  ) => RunningApp<E, RuntimeInfoOf<X>>;

  await awaitExit(boot(module, options), exit);
};
