/**
 * The handlers PORT is the starter's own, typed by the contract, and a
 * provider for it is checked against the contract at the `AmqpHandlers(...)`
 * call and again at `AmqpModule(...)` — not erased to `Record<string,
 * unknown>`. A record that misses a consumer, or names one the contract does
 * not declare, fails to typecheck there rather than at the first delivery,
 * silently to the DLQ; and a provider built for one contract cannot be handed
 * to a module declaring another.
 *
 * Its own contract rather than `test-fixtures.js`'s: that module pulls in
 * `@unthrown/vitest`'s matcher augmentation, which this file's own
 * `tsconfig.test-d.json` — `src/**\/*.test-d.ts` only — never loads.
 */
import {
  defineContract,
  defineEventConsumer,
  defineEventPublisher,
  defineExchange,
  defineMessage,
  defineQueue,
} from "@amqp-contract/contract";
import { Env } from "@btravstack/config";
import { start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { z } from "zod";

import { AmqpModule } from "./amqp-module.js";
import { AmqpHandlers, AmqpRuntime, amqp, type HandlersPortOf } from "./amqp-runtime.js";
import { AmqpHandler, AmqpMessage } from "./handler.js";

const pinExchange = defineExchange("pin-exchange");
const pinQueue = defineQueue("pin-queue");
const pinMessage = defineMessage(z.object({ value: z.string() }));
const pinPublished = defineEventPublisher(pinExchange, pinMessage, { routingKey: "pin.requested" });

const pinContract = defineContract({
  publishers: { echo: pinPublished },
  consumers: { echo: defineEventConsumer(pinPublished, pinQueue) },
});

// Positive: `AmqpHandlers(contract)`'s record arm is `{ inject, unit?, sync }`
// on the starter's handlers port typed for the contract, so a record with a
// handler for every consumer/rpc key the contract declares compiles, and the
// provider satisfies both the sugar and the primitive.
const pinHandlers = AmqpHandlers(pinContract)({
  inject: {},
  sync: () => ({ echo: () => OkAsync(undefined) }),
});
AmqpModule("Pin")({ contract: pinContract, handlers: pinHandlers, needs: [Env] });
Module("PinByHand")({
  needs: [Env],
  imports: [amqp({ contract: pinContract })],
  provides: [pinHandlers],
  exports: [AmqpRuntime],
});
const _pinPort: HandlersPortOf<typeof pinContract> = pinHandlers.port;

// Negative: `AmqpHandlers` will not build a provider that misses a consumer —
// the port's service is the contract's own record, so the arm is checked
// against it before any module sees it.
// @ts-expect-error -- the `echo` consumer has no handler
AmqpHandlers(pinContract)({ inject: {}, sync: () => ({}) });

// Negative: a typo'd key does not compile. `WorkerInferHandlers` requires
// exactly the contract's own consumer/rpc names, so "ecoh" is neither the
// required `echo` entry nor a key the contract declares.
// @ts-expect-error -- "ecoh" is not one of `pinContract`'s consumer/RPC names, and "echo" is missing
AmqpHandlers(pinContract)({ inject: {}, sync: () => ({ ecoh: () => undefined, anything: 1 }) });

// Negative: a provider built for ANOTHER contract is refused by the module —
// the port's instance is typed per contract, so the check is structural on
// the handlers record, not on a name.
const otherContract = defineContract({
  publishers: { other: pinPublished },
  consumers: { other: defineEventConsumer(pinPublished, pinQueue) },
});
const otherHandlers = AmqpHandlers(otherContract)({
  inject: {},
  sync: () => ({ other: () => OkAsync(undefined) }),
});
const _otherOptions = { contract: pinContract, handlers: otherHandlers } as const;
// @ts-expect-error -- built for `otherContract`: its record has `other`, not `echo`
AmqpModule("Other")(_otherOptions);

// Negative: a hand-declared port of another id is not the starter's — the
// starter needs ITS port, so a root providing a different one still owes it.
// Since the `needs` gate that is refused HERE, at the module that owes it,
// and `start` refuses the module. It is the KERNEL's gate rather than di's
// declaration one: the port is owed by the STARTER, an import, and an
// import's needs travel without the importer re-declaring them.
class NoHandlers extends Port("NoHandlers")<Record<never, never>> {}
const Unmet = Module("Unmet")({
  imports: [amqp({ contract: pinContract })],
  provides: [Provider(NoHandlers)({ inject: {}, value: {} })],
  exports: [AmqpRuntime],
});
// @ts-expect-error -- and `start` refuses it too, on the needs channel
start(Unmet, { signals: false, probes: false });

// The passthrough options are the library's own types, never a
// `Record<string, unknown>` bag (issue #25's policy): a key the library does
// not accept is refused at the composition root, not silently ignored by the
// broker client.
amqp({
  contract: pinContract,
  connectionOptions: { heartbeatIntervalInSeconds: 5, reconnectTimeInSeconds: 10 },
  defaultConsumerOptions: { prefetch: 16 },
});

amqp({
  contract: pinContract,
  // @ts-expect-error -- `heartbeat` is amqplib's spelling; the manager's is `heartbeatIntervalInSeconds`
  connectionOptions: { heartbeat: 5 },
});

amqp({
  contract: pinContract,
  // @ts-expect-error -- `prefetchCount` is not a `ConsumerOptions` key
  defaultConsumerOptions: { prefetchCount: 16 },
});

// The root's `unit` gate. A piece's `unit:` record is a promise the ROOT has to
// keep: `context.unit.tenant` resolves out of the fork, so the bound
// `unit.message` module must export `Tenant` or the read defects at the first
// delivery. Nothing else checks it — the piece and the root are typed
// independently — so this is the gate, and each negative below is the assertion
// that it still fires.
const Message = AmqpMessage(pinContract);
class Tenant extends Port("PinTenant")<{ readonly id: string }> {}
class Elsewhere extends Port("PinElsewhere")<{ readonly n: number }> {}

const TenantUnit = Module("PinTenantUnit")({
  needs: [Message],
  provides: [
    Provider(Tenant)({
      inject: { message: Message },
      sync: ({ message }) => ({ id: message.payload.value }),
    }),
  ],
  exports: [Tenant],
});

const ElsewhereUnit = Module("PinElsewhereUnit")({
  provides: [Provider(Elsewhere)({ inject: {}, value: { n: 1 } })],
  exports: [Elsewhere],
});

const scopedPiece = AmqpHandler(
  pinContract,
  "echo",
)({
  inject: {},
  unit: { tenant: Tenant },
  sync:
    () =>
    ({ context }) =>
      OkAsync(void context.unit.tenant.id),
});
const scopedHandlers = AmqpHandlers(pinContract)([scopedPiece]);

// Positive, and two assertions in one: the bound module exports what the piece
// injects, so the gate clears — and `start` accepts the root, so the module's
// own `needs: [AmqpMessage(contract)]` never surfaced as an unmet need. The
// fork's seed is what discharges it, and `UnitNeedsOf` subtracts it for that
// reason; without the subtraction this line would be the failure.
const _seedIsNotANeed = start(
  AmqpModule("PinUnitSatisfied")({
    contract: pinContract,
    handlers: scopedHandlers,
    provides: [scopedPiece],
    unit: { message: TenantUnit },
  }),
  { signals: false, probes: false },
);
void _seedIsNotANeed;

const _wrongUnit = {
  contract: pinContract,
  handlers: scopedHandlers,
  provides: [scopedPiece],
  unit: { message: ElsewhereUnit },
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: `ElsewhereUnit` exports no `Tenant`
AmqpModule("PinUnitWrong")(_wrongUnit);

const _noUnit = {
  contract: pinContract,
  handlers: scopedHandlers,
  provides: [scopedPiece],
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: nothing is bound, so `Tenant` is nowhere
AmqpModule("PinUnitUnbound")(_noUnit);

// The RECORD arm declares `unit:` too, and it reaches the root's gate exactly
// as a piece's does: `sync` sees `context.unit` typed by what the record
// declared, and `_declaredUnit` carries it to `AmqpModule`.
const recordHandlers = AmqpHandlers(pinContract)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    echo: ({ context }) => OkAsync(void context.unit.tenant.id),
  }),
});

// Negative: a name the record did not declare is not on `context.unit` at all.
AmqpHandlers(pinContract)({
  inject: {},
  unit: { tenant: Tenant },
  sync: () => ({
    echo: (helpers) => {
      // @ts-expect-error -- `user` is no name this record declared on `unit`
      void helpers.context.unit.user;
      return OkAsync(undefined);
    },
  }),
});

// Positive: the bound module exports what the record arm declared, so the gate
// clears — the record arm's own half of the pair the pieces pin above.
const _recordUnitSatisfied = start(
  AmqpModule("PinRecordUnitSatisfied")({
    contract: pinContract,
    handlers: recordHandlers,
    unit: { message: TenantUnit },
  }),
  { signals: false, probes: false },
);
void _recordUnitSatisfied;

const _wrongRecordUnit = {
  contract: pinContract,
  handlers: recordHandlers,
  unit: { message: ElsewhereUnit },
} as const;
// @ts-expect-error -- UNIT DOES NOT PROVIDE: `ElsewhereUnit` exports no `Tenant`
AmqpModule("PinRecordUnitWrong")(_wrongRecordUnit);

// Positive: a root whose pieces declare no `unit:` is gated on nothing, bound
// module or not — which is what keeps `examples/order-amqp-worker` compiling.
const plainPiece = AmqpHandler(
  pinContract,
  "echo",
)({ inject: {}, sync: () => () => OkAsync(undefined) });
AmqpModule("PinUnitUndeclared")({
  contract: pinContract,
  handlers: AmqpHandlers(pinContract)([plainPiece]),
  provides: [plainPiece],
  unit: { message: ElsewhereUnit },
});
