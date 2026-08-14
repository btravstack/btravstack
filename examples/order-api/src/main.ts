import { Config, describeIssues } from "@btravstack/config";
import { runMain, start } from "@btravstack/start-core";
import { P } from "unthrown";

import { orderApiRuntime } from "./api-runtime.js";
import { PROBE_PORT_DEFAULT } from "./config.js";
import { OrderApiModule } from "./module.js";

/**
 * The whole process, in one expression: validate the configuration, build the
 * graph, serve it, and turn the exit report into a process exit code. Nothing
 * here catches anything — a malformed environment is a modeled `Err`, a failure
 * to start is the module's own `Err`, a bug is a `Defect`, and `runMain` maps
 * the last two onto exit codes.
 *
 * There is no `env.ts` any more, and nothing is threaded into the runtime: the
 * listening port is a config the graph provides and `orderApiRuntime` reads
 * for itself.
 *
 * Typechecked by the gate, not executed by it. The example packages are
 * source-only — no build step, `main` pointing straight at `src/` — so there is
 * no compiled entry for `node` to run, and every spec drives `start` directly.
 * This file is the shape a real entry point takes.
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
// every config reachable from the root, and `Config.parse` validates all of
// them against one source, aggregating every wrong variable into a single
// `ConfigInvalid`. An operator who mistyped three of them learns all three
// from this boot, instead of one per deploy.
//
// `ConfigInvalid` is a `TaggedError`, so the matcher names it. The fold this
// replaced reported one schema's issues and had to reach for `P._` behind a
// lint-disable, because a `SchemaIssues` array is a single type with no
// discriminant and so nothing to enumerate.
await Config.parse(Config.collect(OrderApiModule), process.env).match({
  ok: () =>
    runMain(
      start(OrderApiModule, {
        runtime: orderApiRuntime(),
        probes: { port: probePort },
      }),
    ),
  errCases: (matcher) =>
    matcher.with(P.tag("config/ConfigInvalid"), (error) => abort(describeIssues(error.issues))),
  defect: (cause) => abort(`the configuration could not be validated: ${String(cause)}`),
});
