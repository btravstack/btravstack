import { runMain } from "@btravstack/core";
import { createLogger, jsonSink, kernelEvents } from "@btravstack/observability";

import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

/**
 * The whole process, in one call: build the graph, serve it, and turn the exit
 * report into a process exit code. The process reads `PORT` (default `3000`),
 * `HOST` (default `0.0.0.0`), `LOG_LEVEL` (default `info`) and `PROBE_PORT`
 * (default `9000`) from the environment — inside the graph, not here — and a
 * malformed one is the kernel's to report: a `startFailed` event and exit code
 * `78`.
 *
 * `RequestModule` is forked around every request by the kernel: `RequestSpan`
 * is built as the request opens and torn down as it closes, reading `Logger`
 * out of the application scope. The handler never sees the fork happen.
 *
 * `onEvent` puts the kernel's own lifecycle events in the same stream as the
 * application's lines — one shape, one set of fields, one thing to search —
 * instead of the kernel's default JSON on stderr. The logger here is built by
 * hand rather than resolved from the graph, and it has to be: `building` is
 * emitted while the graph is still being constructed, and a `startFailed` is
 * emitted when it never finished, so an `onEvent` that resolved its sink out
 * of the context it is watching would have nothing to write the two events
 * that matter most with. It is the same `jsonSink()` the graph's own `Logger`
 * defaults to, so the two streams interleave cleanly; only the `LOG_LEVEL`
 * binding is out of reach, which is why this one logs at the default level.
 * Shown here once — the other two `main.ts` files stay a single line, because
 * the kernel's own stderr sink is a fine default and this is the upgrade, not
 * the requirement.
 *
 * Typechecked by the gate, not executed by it. The example packages are
 * source-only — no build step, `main` pointing straight at `src/` — so there is
 * no compiled entry for `node` to run, and every spec drives `start` directly.
 */
await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
