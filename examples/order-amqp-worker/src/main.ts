import { runMain } from "@btravstack/core";
import { createLogger, kernelEvents } from "@btravstack/observability";

import { logSink, OrderAmqpWorker } from "./module.js";

/**
 * The broadcast process — the whole of it. The graph reads its own
 * environment: `AMQP_URL` through `@btravstack/amqp-worker`'s `AmqpConfig`,
 * `OUTBOX_TENANTS` and `OUTBOX_POLL_MS` through `@btravstack/outbox`'s
 * `outbox()`, `PROBE_PORT` through the kernel; a bad value is a `startFailed`
 * event and exit code 78, reported by `runMain` itself. No connection dance
 * either — the worker and the publisher's client each own their connection
 * lease, so there is nothing to open before `start` and nothing to close after
 * it.
 *
 * `onEvent` puts the kernel's own lifecycle events on the same pino sink the
 * graph's `Logger` writes to — built by hand, because `building` is emitted
 * before there is a graph to resolve a logger from.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
await runMain(OrderAmqpWorker, { onEvent: kernelEvents(createLogger(logSink)) });
