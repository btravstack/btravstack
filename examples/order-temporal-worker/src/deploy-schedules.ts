import { createLogger, jsonSink } from "@btravstack/observability";

import { deploySchedules } from "./schedules.js";

/**
 * `pnpm deploy:schedules` — the one-shot a release runs beside rolling the
 * worker out: register every tenant's nightly sweep, idempotently, and exit
 * non-zero if any was not. Errors are values here, so a script that ignored
 * this would exit `0` with nothing registered — the failure the scheduling
 * how-to is about.
 *
 * `process.env` is handed over once, as the `Env` a booted process would get
 * from `start`; everything after that is read through `Config`, so a missing
 * `SWEEP_TENANTS` is a `ConfigInvalid` naming it.
 *
 * Typechecked by the gate, not executed by it — `schedules.spec.ts` drives
 * `deploySchedules` against the shared Temporal directly.
 */
const logger = createLogger(jsonSink());

const deployed = await deploySchedules(process.env)
  .tap((outcomes) =>
    logger.info("the sweep schedules are ensured", { outcomes: outcomes.join(",") }),
  )
  .tapFailure((failure) =>
    logger.error(
      "the sweep schedules were not ensured",
      {},
      failure.tag === "Err" ? failure.error : failure.cause,
    ),
  );

process.exitCode = deployed.isOk() ? 0 : 1;
