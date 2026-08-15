/**
 * The compile-time half of the broadcast deployment: `start` resolves its
 * runtime from the `AmqpRuntime` port `@btravstack/amqp`'s starter provides
 * and the composition root exports, so a module that exports no runtime is a
 * call-site arity error. Type-checked by this package's `test:types` script,
 * never executed.
 *
 * There is no UNSATISFIED RUNTIME NEEDS negative any more: the runtime has
 * none. What used to be its needs — the handlers, and what they read — is now
 * a port the starter DEPENDS on, so a composition without a provider for it is
 * di's own gate: the module's needs channel carries `OrderHandlers`, and
 * `start` accepts only `Scope | Env` there.
 */
import { AmqpRuntime, amqp } from "@btravstack/amqp";
import { start } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { ApplicationModule, Logger, PlaceOrder } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { OrderHandlers } from "./handlers.js";
import { OrderAmqpWorker } from "./module.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime, so the gate collapses to
// an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderAmqpWorker, options);

// The same graph without `amqp()`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessAmqp = Module("RuntimelessAmqp")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, Logger],
});

// Negative: the gate becomes a required two-element tuple naming the missing
// runtime, and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessAmqp, options);

// The starter without the handlers it depends on: `OrderHandlers` is neither
// provided nor imported, so it stays in the module's needs channel. Spelled
// with the `amqp()` primitive rather than `AmqpModule`, since the sugar cannot
// leave the handlers out — that is what it is for.
const HandlerlessAmqp = Module("HandlerlessAmqp")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    amqp({ contract: orderContract, handlers: OrderHandlers }),
  ],
  exports: [AmqpRuntime, PlaceOrder, Logger],
});

// Negative, di's gate rather than the kernel's: `start` takes a
// `Module<X, E, Scope | Env>`, and this one still needs `OrderHandlers`.
// @ts-expect-error — the module's needs channel carries OrderHandlers, which nothing provides.
const _missingHandlers = start(HandlerlessAmqp, options);
