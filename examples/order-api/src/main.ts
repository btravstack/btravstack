import { runMain, start } from "@btravstack/start";

import { OrderApiModule } from "./module.js";
import { orpcRuntime } from "./orpc-runtime.js";

/**
 * The whole process, in one expression: build the graph, serve it, and turn the
 * exit report into a process exit code. Nothing here catches anything — a
 * failure to start is a modeled `Err`, a bug is a `Defect`, and `runMain` maps
 * both onto exit codes.
 *
 * Typechecked by the gate, not executed by it. The example packages are
 * source-only — no build step, `main` pointing straight at `src/` — so there is
 * no compiled entry for `node` to run, and every spec drives `start` directly.
 * This file is the shape a real entry point takes.
 */
await runMain(
  start(OrderApiModule, {
    runtime: orpcRuntime({ port: Number(process.env["PORT"] ?? 3000) }),
    probes: { port: Number(process.env["PROBE_PORT"] ?? 9000) },
  }),
);
