import { runMain } from "@btravstack/core";

import { OrderAmqpWorker } from "./module.js";

/**
 * The broadcast process — the whole of it. The graph reads its own
 * environment: `AMQP_URL` and `OUTBOX_POLL_MS` through `AmqpConfig`,
 * `PROBE_PORT` through the kernel; a bad value is a `startFailed` event and
 * exit code 78, reported by `runMain` itself. No connection dance either —
 * `TypedAmqpWorker` owns its own connection, so there is nothing to open
 * before `start` and nothing to close after it.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
await runMain(OrderAmqpWorker);
