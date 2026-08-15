import { runMain } from "@btravstack/core";
import { P } from "unthrown";

import { describeEnvIssues, readEnv, type Env } from "./env.js";
import { orderAmqpWorker } from "./module.js";

/**
 * The broadcast process, and — apart from the composition root it names — the
 * same shape every deployment's `main.ts` is: validate the environment, build the
 * graph, serve it, and turn the exit report into a process exit code. No connection
 * dance here — `TypedAmqpWorker` owns its own connection, so unlike
 * `order-temporal-worker`'s `main.ts` there is nothing to open before `start` and
 * nothing to close after it.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
const work = (env: Env): Promise<void> =>
  runMain(orderAmqpWorker({ urls: [env.AMQP_URL], relay: { pollMs: env.OUTBOX_POLL_MS } }), {
    probes: { port: env.PROBE_PORT },
  });

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
