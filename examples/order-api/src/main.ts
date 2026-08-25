import { runMain } from "@btravstack/core";
import { createLogger, jsonSink, kernelEvents } from "@btravstack/observability";

import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

/**
 * The whole process, in one call: build the graph, serve it, and turn the exit
 * report into a process exit code. `PORT`, `HOST`, `LOG_LEVEL` and `PROBE_PORT`
 * are read from the environment inside the graph, not here, and a malformed one
 * is the kernel's to report — a `startFailed` event and exit code `78`.
 *
 * `RequestModule` is forked around every request by the kernel; the handler
 * never sees the fork happen.
 *
 * `onEvent` puts the kernel's own lifecycle events in the application's stream
 * rather than the kernel's default JSON on stderr. The logger is built by hand
 * rather than resolved, and has to be: `building` is emitted while the graph is
 * still being constructed, so a sink resolved from that context would have
 * nothing to write the two events that matter most with. Shown here once — the
 * other two `main.ts` files stay a single line, because the stderr sink is a
 * fine default and this is the upgrade, not the requirement.
 *
 * Typechecked by the gate, not executed by it.
 */
await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
