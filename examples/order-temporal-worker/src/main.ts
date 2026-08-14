import { Config, describeIssues } from "@btravstack/config";
import { runMain, start } from "@btravstack/start-core";
import { orderContract } from "@btravstack/start-example-order-temporal-contract";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";
import { OkAsync, P, fromSafePromise, type AsyncResult } from "unthrown";

import { PROBE_PORT_DEFAULT, TEMPORAL_ADDRESS_DEFAULT } from "./config.js";
import { OrderTemporalModule } from "./module.js";
import { temporalWorkerRuntime } from "./temporal-runtime.js";

// The two values this deployment still reads out of `process.env` by hand.
// Both are declared as configs and validated below with every other variable,
// so by the time they are used they are known to be well-formed — but both are
// needed *before* the graph exists: `start` binds the probe server before it
// builds anything, and the connection has to be open to be handed to the
// runtime. Phase 1 of `@btravstack/config` has no way to read one config's
// value outside a graph, and phase 2's kernel integration is what deletes
// these two lines: `start` will own the source and resolve its own
// configuration. `TEMPORAL_NAMESPACE`, which is *not* needed early, already
// travels the right way — the runtime reads it off the context.
const probePort = Number(process.env["PROBE_PORT"] ?? PROBE_PORT_DEFAULT);
const address = process.env["TEMPORAL_ADDRESS"] ?? TEMPORAL_ADDRESS_DEFAULT;

/**
 * The third process, and — apart from the runtime it names and the connection
 * it opens — the same one the other two `main.ts` files are: validate the
 * configuration, build the graph, serve it, and turn the exit report into a
 * process exit code.
 *
 * The connection is opened here because it is a *resource with an owner*, not
 * a value: whoever opens it closes it, which is why the close is **here** and
 * not in the runtime's `stop()`. `src/test-fixtures.ts` boots a fresh worker
 * per test against the *one* `testEnv.nativeConnection` the whole file shares,
 * so a runtime that closed what it was given would tear the test environment
 * down under the next test. The asymmetry a runtime closing it would introduce
 * is the smell; the symmetry is the rule.
 *
 * `workflowsPathFromURL` points Temporal at the workflow module so it can
 * bundle it for the sandbox; a spec hands over a prebuilt bundle instead,
 * which is why `WorkflowSource` has two arms.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
const work = (): AsyncResult<void, never> =>
  // A frontend service that will not answer is not an anticipated outcome of
  // *this* deployment — there is no domain error to name it — so it rides the
  // defect channel and the fold below turns it into an exit code.
  fromSafePromise(NativeConnection.connect({ address })).flatMap((connection) =>
    fromSafePromise(
      runMain(
        start(OrderTemporalModule, {
          runtime: temporalWorkerRuntime({
            contract: orderContract,
            connection,
            workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
          }),
          probes: { port: probePort },
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

// One report for the whole graph. `Config.collect` walks the module tree for
// every config reachable from the root, and `Config.parse` validates all of
// them against one source, aggregating every wrong variable into a single
// `ConfigInvalid`. An operator who mistyped three of them learns all three
// from this boot, instead of one per deploy.
//
// `ConfigInvalid` is a `TaggedError`, so the matcher names it. The fold this
// replaced reported one schema's issues and had to reach for `P._` behind a
// lint-disable, because a `SchemaIssues` array is a single type with no
// discriminant and so nothing to enumerate.
await Config.parse(Config.collect(OrderTemporalModule), process.env).match({
  ok: () =>
    work().match({
      ok: () => {},
      // Nothing can land in the error channel — `work` is typed
      // `AsyncResult<void, never>` — so the matcher has no case to name.
      errCases: (matcher) => matcher,
      defect: (cause) => abort(`could not reach the Temporal service: ${String(cause)}`),
    }),
  errCases: (matcher) =>
    matcher.with(P.tag("config/ConfigInvalid"), (error) => abort(describeIssues(error.issues))),
  defect: (cause) => abort(`the configuration could not be validated: ${String(cause)}`),
});
