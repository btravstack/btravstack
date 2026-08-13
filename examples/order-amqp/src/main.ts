import { runMain, start } from "@btravstack/start";
import { orderContract } from "@btravstack/start-example-order-amqp-contract";
import { P, fromSafePromise } from "unthrown";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { describeEnvIssues, readEnv } from "./env.js";
import { OrderAmqpModule } from "./module.js";

/**
 * The fourth process, and the simplest of the four `main.ts` files: validate
 * the environment, build the graph, serve it, and turn the exit report into a
 * process exit code. No connection dance here — `TypedAmqpWorker` owns its own
 * connection, so unlike `order-temporal`'s `main.ts` there is nothing to open
 * before `start` and nothing to close after it.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */

/** sysexits(3) `EX_CONFIG`: the deployment is wrong, not the code. */
const abort = (reason: string): void => {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 78;
};

await readEnv().match({
  ok: (env) =>
    fromSafePromise(
      runMain(
        start(OrderAmqpModule, {
          runtime: orderAmqpRuntime({ contract: orderContract, urls: [env.AMQP_URL] }),
          probes: { port: env.PROBE_PORT },
        }),
      ),
    ).match({
      ok: () => {},
      // Nothing can land in the error channel — the inner `AsyncResult` is
      // typed `AsyncResult<void, never>` — so the matcher has no case to name.
      errCases: (matcher) => matcher,
      defect: (cause) => abort(`the worker could not start: ${String(cause)}`),
    }),
  // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is the issues array: one type with no discriminant, so the single arm IS the enumeration
  errCases: (matcher) => matcher.with(P._, (issues) => abort(describeEnvIssues(issues))),
  defect: (cause) => abort(`the environment could not be validated: ${String(cause)}`),
});
