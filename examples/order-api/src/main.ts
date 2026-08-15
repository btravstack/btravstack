import { runMain } from "@btravstack/core";

import { OrderApi } from "./module.js";
import { RequestModule } from "./request-scope.js";

/**
 * The whole process, in one call: build the graph, serve it, and turn the exit
 * report into a process exit code. The process reads `PORT` (default `3000`),
 * `HOST` (default `0.0.0.0`) and `PROBE_PORT` (default `9000`) from the
 * environment — inside the graph, not here — and a malformed one is the
 * kernel's to report: a `startFailed` event and exit code `78`.
 *
 * `RequestModule` is forked around every request by the kernel: `RequestSpan`
 * is built as the request opens and torn down as it closes, reading `Logger`
 * out of the application scope. The handler never sees the fork happen.
 *
 * Typechecked by the gate, not executed by it. The example packages are
 * source-only — no build step, `main` pointing straight at `src/` — so there is
 * no compiled entry for `node` to run, and every spec drives `start` directly.
 */
await runMain(OrderApi, { unit: RequestModule });
