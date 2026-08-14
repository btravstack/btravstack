import { Config, describeIssues } from "@btravstack/config";
import { runMain, start } from "@btravstack/start-core";
import { P } from "unthrown";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { PROBE_PORT_DEFAULT } from "./config.js";
import { OrderAmqpModule } from "./module.js";

/**
 * The broadcast process, and — apart from the runtime it names — the same
 * shape every deployment's `main.ts` is: validate the configuration, build the
 * graph, serve it, and turn the exit report into a process exit code. No
 * connection dance here — `TypedAmqpWorker` owns its own connection, so unlike
 * `order-temporal-worker`'s `main.ts` there is nothing to open before `start`
 * and nothing to close after it.
 *
 * There is no `env.ts` any more, and nothing is threaded into the runtime: the
 * broker URL and the relay's sweep interval are configs the graph provides and
 * the runtime reads for itself.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */

/** sysexits(3) `EX_CONFIG`: the deployment is wrong, not the code. */
const abort = (reason: string): void => {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 78;
};

// The one value this deployment still reads out of `process.env` by hand.
// `PROBE_PORT` is declared in `probeConfig` and validated below with every
// other variable, so by the time this is used it is known to be a whole number
// in range — but `start` binds the probe server *before* it builds the graph,
// and phase 1 of `@btravstack/config` has no way to read one config's value
// outside a graph. Phase 2's kernel integration is what deletes this line:
// `start` will own the source and resolve its own configuration.
const probePort = Number(process.env["PROBE_PORT"] ?? PROBE_PORT_DEFAULT);

// One report for the whole graph. `Config.collect` walks the module tree for
// every config reachable from the root — this deployment's three, and any a
// library it imports declares — and `Config.parse` validates all of them
// against one source, aggregating every wrong variable into a single
// `ConfigInvalid`. An operator who mistyped three of them learns all three
// from this boot, instead of one per deploy.
//
// `ConfigInvalid` is a `TaggedError`, so the matcher names it. The fold this
// replaced reported one schema's issues and had to reach for `P._` behind a
// lint-disable, because a `SchemaIssues` array is a single type with no
// discriminant and so nothing to enumerate.
await Config.parse(Config.collect(OrderAmqpModule), process.env).match({
  ok: () =>
    runMain(
      start(OrderAmqpModule, {
        runtime: orderAmqpRuntime(),
        probes: { port: probePort },
      }),
    ),
  errCases: (matcher) =>
    matcher.with(P.tag("config/ConfigInvalid"), (error) => abort(describeIssues(error.issues))),
  defect: (cause) => abort(`the configuration could not be validated: ${String(cause)}`),
});
