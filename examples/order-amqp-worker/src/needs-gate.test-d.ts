/**
 * The compile-time half of the broadcast deployment: `orderAmqpRuntime`
 * declares four ports in `needs` — two application services and two configs —
 * and `start`'s phantom rest-tuple gate turns a module that does not export
 * them all into a call-site arity error. Type-checked by this package's
 * `test:types` script, never executed.
 *
 * Together with `order-api`'s and `order-temporal-worker`'s, this is what
 * makes the claim testable rather than asserted: runtimes with non-empty
 * `needs`, all proven against the same application graph at the `start(...)`
 * call site. Configuration is inside that proof now, not beside it: a
 * deployment that forgets to import `amqpConfig` fails here, not at boot.
 */
import { Config } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { start } from "@btravstack/start-core";
import { ApplicationModule, Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { amqpConfig } from "./config.js";
import { OrderAmqpModule } from "./module.js";
import { outboxRelayConfig } from "./outbox-relay.js";

const options = {
  runtime: orderAmqpRuntime(),
  signals: false,
  probes: false,
} as const;

// Positive: the composition root exports every port the runtime needs (and a
// writer's port it does not), so the gate collapses to an empty tuple and this
// is an ordinary two-argument call.
const _wired = start(OrderAmqpModule, options);

// The same graph, one port short: `Outbox` is provided (the persistence layer
// carries it) but not exported, so it is not in the application context the
// runtime is handed. Both configs *are* exported, so the gate can only be
// answering about the one genuinely missing port.
const PartialAmqp = Module("PartialAmqp")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    amqpConfig,
    outboxRelayConfig,
    Config.source(process.env),
  ],
  exports: [PlaceOrder, Logger, amqpConfig, outboxRelayConfig],
});

// Negative: the gate becomes a required two-element tuple naming the unmet need,
// and the call fails on arity.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: the module does not export Outbox.
const _missingOutbox = start(PartialAmqp, options);
