import { start } from "@btravstack/core";
/**
 * The compile-time half of the broadcast deployment: `start` resolves its
 * runtime from the `OrderAmqpRuntime` port the composition root exports, and
 * that runtime declares two ports in `needs` — so a module that exports no
 * runtime, or one that does not export both ports, is a call-site arity
 * error. Type-checked by this package's `test:types` script, never executed.
 *
 * Together with `order-api`'s and `order-temporal-worker`'s, this is what
 * makes the claim testable rather than asserted: runtimes with non-empty
 * `needs`, all proven against the same application graph at the `start(...)`
 * call site.
 */
import { Module } from "@btravstack/di";
import { ApplicationModule, Logger, PlaceOrder } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { OrderAmqpRuntime, amqpModule } from "./amqp-runtime.js";
import { orderAmqpWorker } from "./module.js";

const transport = { urls: ["amqp://127.0.0.1:5672"], relay: { pollMs: 200 } } as const;

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime and both ports it needs
// (and a writer's port it does not), so the gate collapses to an empty tuple
// and this is an ordinary two-argument call.
const _wired = start(orderAmqpWorker(transport), options);

// The same graph without `amqpModule`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessAmqp = Module("RuntimelessAmqp")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the missing
// runtime, and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessAmqp, options);

// The same graph, one port short: `Outbox` is provided (the persistence layer
// carries it) but not exported, so it is not in the application context the
// runtime is handed.
const PartialAmqp = Module("PartialAmqp")({
  imports: [ApplicationModule, PersistenceModule, amqpModule(transport)],
  exports: [OrderAmqpRuntime, PlaceOrder, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Outbox.
const _missingOutbox = start(PartialAmqp, options);
