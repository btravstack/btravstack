import { runMain } from "@btravstack/core";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import { httpRuntime } from "@btravstack/http";
import { P } from "unthrown";

import { describeEnvIssues, readEnv, type Env } from "./env.js";
import { ApiHandler } from "./handler.js";
import { OrderApiModule } from "./module.js";
import { RequestModule } from "./request-scope.js";

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
  runMain(OrderApiModule, {
    runtime: httpRuntime({
      port: env.PORT,
      // The HTTP surface is itself a service: the runtime resolves it out of
      // the request's context along with the use cases it serves.
      needs: [ApiHandler, PlaceOrder, FindOrder],
      handler: (request, response, ctx) => ctx.get(ApiHandler)(request, response, ctx),
    }),
    // Forked around every request by the kernel: `RequestSpan` is built as the
    // request opens and torn down as it closes, reading `Logger` out of the
    // application scope. The handler never sees the fork happen.
    unit: RequestModule,
    probes: { port: env.PROBE_PORT },
  });

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
