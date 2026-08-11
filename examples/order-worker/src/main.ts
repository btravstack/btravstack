import { runMain, start } from "@btravstack/start";
import { P } from "unthrown";

import { describeEnvIssues, readEnv, type Env } from "./env.js";
import { OrderWorkerModule } from "./module.js";
import { queueWorkerRuntime } from "./queue-runtime.js";
import { createOrderQueue } from "./queue.js";

/**
 * The second process, and — apart from the runtime it names — the same one
 * `order-api/src/main.ts` is: validate the environment, build the graph, serve
 * it, and turn the exit report into a process exit code.
 *
 * The queue is created here because this example's broker is a plain in-memory
 * object; a real deployment builds an AMQP channel from the environment
 * instead, and nothing above this line changes. Typechecked by the gate, not
 * executed by it — the example packages are source-only, and every spec drives
 * `start` directly.
 */
const work = (env: Env): Promise<void> =>
  runMain(
    start(OrderWorkerModule, {
      runtime: queueWorkerRuntime({
        queue: createOrderQueue(),
        concurrency: env.CONCURRENCY,
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
  ok: work,
  // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is the issues array: one type with no discriminant, so there is nothing to enumerate and the single arm IS the enumeration
  errCases: (matcher) => matcher.with(P._, (issues) => abort(describeEnvIssues(issues))),
  defect: (cause) => abort(`the environment could not be validated: ${String(cause)}`),
});
