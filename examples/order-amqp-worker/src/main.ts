import { runMain } from "@btravstack/core";
import { UnitSpanModule } from "@btravstack/observability/otel";

import { OrderAmqpWorker } from "./module.js";

/**
 * The broadcast process — the whole of it. The graph reads its own
 * environment: `AMQP_URL` through `@btravstack/amqp`'s `AmqpConfig`,
 * `OUTBOX_POLL_MS` through `RelayConfig`, `PROBE_PORT` through the kernel; a
 * bad value is a `startFailed` event and exit code 78, reported by `runMain`
 * itself. No connection dance either — the worker and the relay's client each
 * own their connection lease, so there is nothing to open before `start` and
 * nothing to close after it.
 *
 * Typechecked by the gate, not executed by it — the example packages are
 * source-only, and every spec drives `start` directly.
 */
// `UnitSpanModule` opens an OTel span per delivery, carrying the same unit
// ids the logger stamps.
await runMain(OrderAmqpWorker, { unit: UnitSpanModule });
