/**
 * The compile-time half of the broadcast deployment: `orderAmqpRuntime`
 * declares two ports in `needs`, and `start`'s phantom rest-tuple gate turns a
 * module that does not export both into a call-site arity error. Type-checked
 * by this package's `test:types` script, never executed.
 *
 * Together with `order-api`'s and `order-temporal-worker`'s, this is what
 * makes the claim testable rather than asserted: runtimes with non-empty
 * `needs`, all proven against the same application graph at the `start(...)`
 * call site.
 */
import { Module } from "@btravstack/di";
import { start } from "@btravstack/start-core";
import { orderContract } from "@btravstack/start-example-order-amqp-contract";
import { ApplicationModule, Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { OrderAmqpModule } from "./module.js";

const options = {
  runtime: orderAmqpRuntime({
    contract: orderContract,
    urls: ["amqp://127.0.0.1:5672"],
    relay: { pollMs: 200 },
  }),
  signals: false,
  probes: false,
} as const;

// Positive: the composition root exports both ports the runtime needs (and a
// writer's port it does not), so the gate collapses to an empty tuple and this
// is an ordinary two-argument call.
const _wired = start(OrderAmqpModule, options);

// The same graph, one port short: `Outbox` is provided (the persistence layer
// carries it) but not exported, so it is not in the application context the
// runtime is handed.
const PartialAmqp = Module("PartialAmqp")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Outbox.
const _missingOutbox = start(PartialAmqp, options);
