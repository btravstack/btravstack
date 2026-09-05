import { AmqpHandlers, AmqpModule } from "@btravstack/amqp-worker";
import { Env } from "@btravstack/config";
import { Logger, Tracer } from "@btravstack/core";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  OrderApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { mailer } from "@btravstack/mailer";
import { smtpMailer } from "@btravstack/mailer/smtp";
import { observability } from "@btravstack/observability";
import { UnitSpanModule, otel } from "@btravstack/observability/otel";

import { outboxRelay, relayConfig } from "./outbox-relay.js";
import { orderAudit } from "./slices/audit/handler.js";
import { AuditSlice } from "./slices/audit/module.js";
import { orderNotifications } from "./slices/notifications/handler.js";
import { NotificationsSlice } from "./slices/notifications/module.js";

/**
 * The handlers record, composed from each slice's own piece — keyed by the
 * contract's own consumer names, so a consumer with no slice is a compile
 * error and two slices claiming one consumer are di's duplicate-provider
 * defect at build.
 */
export const orderHandlers = AmqpHandlers(orderContract)([orderNotifications, orderAudit]);

/**
 * The composition root of the broadcast deployment: a list of slices plus what
 * no slice owns — the orders vertical the outbox relay writes from (the
 * relay's, not either subscriber's) and the relay itself, a resourceful
 * provider beside the starter. Both halves of the outbox pattern in one graph.
 *
 * Both slices are imported because `orderHandlers`'s pieces are di-discovered
 * through `imports` / `provides` only, never through a provider's own `deps` —
 * but `AmqpHandlers`' composing call above declares each piece's port as one
 * of ITS OWN `deps`, so a dropped import is an undeclared need at THIS call,
 * refused by di's `NeedsGate` naming the exact port, not a runtime surprise.
 *
 * The exports are the writer's surface: what a writer in the same process
 * places and cancels orders through, and what the specs tap. Both write paths
 * leave the outbox an event, which is what this deployment demonstrates.
 *
 * Tenancy is the CONTRACT's, not the transport's: the envelope carries
 * `tenantId`, and the relay's own side is `OUTBOX_TENANTS`. Everything else is
 * read from the environment inside the graph, so `main.ts` boots this value as
 * is and the specs boot it with `env` pointing at each test's own vhost.
 */
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  // This root provides `relayConfig` itself, so `Env` is its OWN provider's
  // need rather than one inherited from the slices below.
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    mailer({ adapter: smtpMailer() }),
    observability(),
    otel(),
  ],
  provides: [relayConfig, outboxRelay],
  // The worker forks `UnitSpanModule` once per delivery, after the message is
  // validated; its own need, `Tracer`, is satisfied by `otel()` above.
  unit: { message: UnitSpanModule },
  // `Tracer` beside `Logger` for the same reason: `UnitSpanModule` reads it
  // out of the application scope once forked.
  exports: [PlaceOrder, OrderRepository, Outbox, Logger, Tracer],
});
