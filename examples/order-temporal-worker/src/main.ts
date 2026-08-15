import { runMain } from "@btravstack/core";

import { OrderTemporalWorker } from "./module.js";

/**
 * The third process, and the same one the other two `main.ts` files are: boot
 * the composition root, serve it, exit with what happened. It reads
 * `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `PROBE_PORT` from the
 * environment — inside the graph, through the starter's `TemporalConfig` and
 * the kernel's own probe binding — and a bad one is the kernel's to report: a
 * `startFailed` event and exit `78`. A service that will not answer is the
 * starter's `TemporalUnreachable`, exit `1`.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
await runMain(OrderTemporalWorker);
