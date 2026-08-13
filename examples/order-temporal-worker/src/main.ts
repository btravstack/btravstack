import { runMain, start } from "@btravstack/start-core";
import { orderContract } from "@btravstack/start-example-order-temporal-contract";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";
import { OkAsync, P, fromSafePromise, type AsyncResult } from "unthrown";

import { describeEnvIssues, readEnv, type Env } from "./env.js";
import { OrderTemporalModule } from "./module.js";
import { temporalWorkerRuntime } from "./temporal-runtime.js";

/**
 * The third process, and — apart from the runtime it names and the connection
 * it opens — the same one the other two `main.ts` files are: validate the
 * environment, build the graph, serve it, and turn the exit report into a
 * process exit code.
 *
 * The connection is opened here for the reason `order-api` binds its port
 * here: it is the *transport*, and a runtime is handed one rather than owning
 * its lifetime. `workflowsPathFromURL` points Temporal at the workflow module
 * so it can bundle it for the sandbox; a spec hands over a prebuilt bundle
 * instead, which is why `WorkflowSource` has two arms.
 *
 * Whoever opens it closes it, which is why the close is **here** and not in the
 * runtime's `stop()`. The runtime is handed a connection it did not open and
 * has no claim on: `src/test-fixtures.ts` boots a fresh worker per test against
 * the *one* `testEnv.nativeConnection` the whole file shares, so a runtime that
 * closed what it was given would tear the test environment down under the next
 * test. The asymmetry a runtime closing it would introduce is the smell; the
 * symmetry is the rule.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
const work = (env: Env): AsyncResult<void, never> =>
  // A frontend service that will not answer is not an anticipated outcome of
  // *this* deployment — there is no domain error to name it — so it rides the
  // defect channel and the fold below turns it into an exit code.
  fromSafePromise(NativeConnection.connect({ address: env.TEMPORAL_ADDRESS })).flatMap(
    (connection) =>
      fromSafePromise(
        runMain(
          start(OrderTemporalModule, {
            runtime: temporalWorkerRuntime({
              contract: orderContract,
              connection,
              namespace: env.TEMPORAL_NAMESPACE,
              workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
            }),
            probes: { port: env.PROBE_PORT },
          }),
          // `.finally`, not a `flatTap`: an open `NativeConnection` holds the
          // event loop, so a startup that ends in a defect is exactly the path
          // that must still close it. `runMain`'s bare `Promise` is the one
          // place a native combinator belongs — it is the documented boundary
          // where the Result world ends — and `close` never rejects, so the
          // exit code `runMain` just set survives.
        ).finally(() => close(connection)),
      ),
  );

/**
 * Closing is teardown, and teardown must not rewrite the outcome: `runMain` has
 * already set the exit code by the time this runs, so a connection that will
 * not close is reported and no more. Letting it become a defect would replace a
 * clean `0` — or a considered `2` for abandoned work — with `EX_CONFIG`.
 *
 * The kernel makes the same distinction with `ExitReport.teardownErrors`, which
 * are collected and never mask the reason the application stopped.
 */
const close = (connection: NativeConnection): AsyncResult<void, never> =>
  fromSafePromise(connection.close()).recoverDefect((cause) => {
    process.stderr.write(`the Temporal connection did not close cleanly: ${String(cause)}\n`);
    return OkAsync();
  });

/** sysexits(3) `EX_CONFIG`: the deployment is wrong, not the code. */
const abort = (reason: string): void => {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 78;
};

await readEnv().match({
  ok: (env) =>
    work(env).match({
      ok: () => {},
      // Nothing can land in the error channel — `work` is typed
      // `AsyncResult<void, never>` — so the matcher has no case to name.
      errCases: (matcher) => matcher,
      defect: (cause) => abort(`could not reach the Temporal service: ${String(cause)}`),
    }),
  // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is the issues array: one type with no discriminant, so there is nothing to enumerate and the single arm IS the enumeration
  errCases: (matcher) => matcher.with(P._, (issues) => abort(describeEnvIssues(issues))),
  defect: (cause) => abort(`the environment could not be validated: ${String(cause)}`),
});
