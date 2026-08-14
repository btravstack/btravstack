import { runMain, start } from "@btravstack/core";
import { FindOrder, Logger, PlaceOrder } from "@btravstack/example-order-application";
import { httpRuntime } from "@btravstack/http";
import { P } from "unthrown";

import { describeEnvIssues, readEnv, type Env } from "./env.js";
import { apiHandler } from "./handler.js";
import { OrderApiModule } from "./module.js";

/**
 * The whole process, in one expression: validate the environment, build the
 * graph, serve it, and turn the exit report into a process exit code. Nothing
 * here catches anything — a malformed environment is a modeled `Err`, a failure
 * to start is the module's own `Err`, a bug is a `Defect`, and `runMain` maps
 * the last two onto exit codes.
 *
 * Typechecked by the gate, not executed by it. The example packages are
 * source-only — no build step, `main` pointing straight at `src/` — so there is
 * no compiled entry for `node` to run, and every spec drives `start` directly.
 * This file is the shape a real entry point takes.
 */
const serve = (env: Env): Promise<void> =>
  runMain(
    start(OrderApiModule, {
      runtime: httpRuntime({
        port: env.PORT,
        needs: [PlaceOrder, FindOrder, Logger],
        handler: apiHandler,
      }),
      probes: { port: env.PROBE_PORT },
    }),
  );

/** sysexits(3) `EX_CONFIG`: the deployment is wrong, not the code. */
const abort = (reason: string): void => {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 78;
};

await readEnv().match({
  ok: serve,
  // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is the issues array: one type with no discriminant, so there is nothing to enumerate and the single arm IS the enumeration
  errCases: (matcher) => matcher.with(P._, (issues) => abort(describeEnvIssues(issues))),
  defect: (cause) => abort(`the environment could not be validated: ${String(cause)}`),
});
