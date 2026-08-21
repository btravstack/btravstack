import { AmqpModule, AmqpRuntime, amqp } from "@btravstack/amqp";
/**
 * The compile-time half of the broadcast deployment: `start` resolves its
 * runtime from the `AmqpRuntime` port `@btravstack/amqp`'s starter provides
 * and the composition root exports, so a module that exports no runtime fails
 * to match the `NO RUNTIME — …` sentence `start` intersects onto its `module`
 * parameter. Type-checked by this package's `test:types` script,
 * never executed.
 *
 * There is no UNSATISFIED RUNTIME PORTS negative any more: the runtime
 * resolves nothing. What it used to resolve — the handlers, and what they
 * read — is now
 * the starter's own handlers port, which the starter DEPENDS on, so a
 * composition without a provider for it is the needs channel, not the marker
 * and not di's `UNSATISFIED DEPENDENCIES` arity gate: the module's needs
 * channel carries that port, `start` accepts only `Scope | Env` there, and the
 * assignability failure names the port.
 *
 * The third negative is about **slices**, and it is the mirror of
 * `order-temporal-worker`'s `FulfillmentlessSlice`. Composing pieces into one
 * provider shields what those pieces close over from the ROOT's needs channel
 * — the composed provider's own `deps` are the piece ports, not the ports a
 * piece declared — and it would be easy to read that as a slice shielding its
 * own needs too. It is not: `AmqpHandler(contract, key)`'s `deps` are the REAL
 * ports named in its `sync` call, so a slice surfaces them the moment it is
 * composed into a root. `LoggerlessAmqp` below is the proof — both slices
 * carried in, `observability()` left out, and `Logger` still reaching `start`.
 */
import { Env } from "@btravstack/config";
import { start } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { OrderApplicationModule, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger, observability } from "@btravstack/observability";

import { OrderAmqpWorker, orderHandlers } from "./module.js";
import { AuditSlice } from "./slices/audit/module.js";
import { NotificationsSlice } from "./slices/notifications/module.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime, so the gate collapses to
// an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderAmqpWorker, options);

// The same graph without `amqp()`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessAmqp = Module("RuntimelessAmqp")({
  needs: [Env],
  imports: [OrderApplicationModule, OrderPersistenceModule, observability()],
  exports: [PlaceOrder, Logger],
});

// Negative: the marker becomes the `NO RUNTIME — …` sentence, which the module
// argument cannot satisfy, so the call fails to typecheck against it.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _noRuntime = start(RuntimelessAmqp, options);

// The starter without the handlers it depends on. Spelled with the `amqp()`
// primitive rather than `AmqpModule`, since the sugar cannot leave the
// handlers out — that is what it is for.
//
// The port is owed by the STARTER, which is an import — so di's declaration
// gate has nothing to say here, and the refusal is the kernel's, on the needs
// channel. That is the division the two gates draw: a module declares what its
// OWN providers read, and an import's needs travel published in its type.
const HandlerlessAmqp = Module("HandlerlessAmqp")({
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability(),
    amqp({ contract: orderContract }),
  ],
  exports: [AmqpRuntime, PlaceOrder, Logger],
});

// @ts-expect-error — the module's needs channel carries the handlers port, which nothing provides.
const _missingHandlers = start(HandlerlessAmqp, options);

// The two real slices, composed into a root that forgets `observability()`.
// Neither slice imports it — a subscriber owns no vertical, so `Logger` is the
// root's to supply — and each slice's handler declares `Logger` in its own
// `sync` call. The relay is deliberately absent: it needs `Logger` too, and
// including it would leave the negative unable to say which of the two leaked.
// Negative, and the one this file exists to add: a slice does NOT shield the
// ports its own pieces declare. Composition shields a piece's deps from the
// root; being inside a slice shields nothing — and each slice says
// `needs: [Logger]` out loud, so what reaches this root is a DECLARED
// obligation. It is still the root's to answer, and this one does not — the
// refusal is the kernel's, since `Logger` arrives through an import.
const LoggerlessAmqp = AmqpModule("LoggerlessAmqp")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [NotificationsSlice, AuditSlice],
});

// @ts-expect-error — UNMET NEED: `Logger` is not assignable to `Env | Scope`.
const _missingLogger = start(LoggerlessAmqp, options);
