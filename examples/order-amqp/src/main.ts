import { runMain, start } from "@btravstack/start";
import { orderContract } from "@btravstack/start-example-order-amqp-contract";
import { P } from "unthrown";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { describeEnvIssues, readEnv, type Env } from "./env.js";
import { OrderAmqpModule } from "./module.js";

/**
 * The fourth process, and — apart from the runtime it names — the same one
 * `order-worker/src/main.ts` is: validate the environment, build the graph,
 * serve it, and turn the exit report into a process exit code. No connection
 * dance here — `TypedAmqpWorker` owns its own connection, so unlike
 * `order-temporal`'s `main.ts` there is nothing to open before `start` and
 * nothing to close after it.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
const work = (env: Env): Promise<void> =>
  runMain(
    start(OrderAmqpModule, {
      runtime: orderAmqpRuntime({ contract: orderContract, urls: [env.AMQP_URL] }),
      probes: { port: env.PROBE_PORT },
    }),
  );

/** sysexits(3) `EX_CONFIG`: the deployment is wrong, not the code. */
const abort = (reason: string): void => {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 78;
};

await readEnv().match({
  ok: work,
  // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is the issues array: one type with no discriminant, so there is nothing to enumerate and the single arm IS the enumeration
  errCases: (matcher) => matcher.with(P._, (issues) => abort(describeEnvIssues(issues))),
  defect: (cause) => abort(`the environment could not be validated: ${String(cause)}`),
});
