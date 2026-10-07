import { AmqpHandlers, AmqpModule } from "@btravstack/amqp-worker";
import { Logger, Tracer } from "@btravstack/core";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { OrderDatabase, OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { mailer } from "@btravstack/mailer";
import { smtpMailer } from "@btravstack/mailer/smtp";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { pinoSink } from "@btravstack/observability/pino";
import { OutboxStore, outbox } from "@btravstack/outbox";
import { storage } from "@btravstack/storage";
import { s3Storage } from "@btravstack/storage/s3";
import pino from "pino";

import { MessageUnitModule } from "./message-unit.js";
import { orderAmqpClient, orderPublisher } from "./outbox-publisher.js";
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
 * Where this deployment's lines go: pino, for its throughput, at `trace` —
 * the level filter stays `LOG_LEVEL`'s, decided before a line reaches a sink.
 * One instance for the process, shared by the graph's `Logger` and by
 * `main.ts`'s kernel events, so both halves land in one stream.
 */
export const logSink = pinoSink(pino({ level: "trace" }));

/**
 * The composition root of the broadcast deployment: a list of slices plus what
 * no slice owns — the orders vertical whose outbox the relay reads (the
 * relay's, not either subscriber's), `@btravstack/outbox`'s relay itself, and
 * the one thing the relay cannot own: what publishing a row means, over a
 * client of this deployment's contract. Both halves of the outbox pattern in
 * one graph.
 *
 * Both slices are imported because `orderHandlers`'s pieces are di-discovered
 * through `imports` / `provides` only, never through a provider's own `deps` —
 * but `AmqpHandlers`' composing call above declares each piece's port as one
 * of ITS OWN `deps`, so a dropped import is an undeclared need at THIS call,
 * refused by di's `NeedsGate` naming the exact port, not a runtime surprise.
 *
 * The relay is acquired as the graph builds, so it is publishing before the
 * consumer is, and released when the scope closes — after the consumer has
 * drained, and before the client it publishes through, which di releases in
 * reverse order of acquisition.
 *
 * The exports are what the message fork and the specs read out of the
 * application scope. `PlaceOrder` and `OrderRepository` are not among them:
 * nothing at the root can build a tenant-bound repository, so a writer in the
 * same process composes its own scope over `OrderDatabase`.
 *
 * Tenancy is the CONTRACT's, not the transport's: the envelope carries
 * `tenantId`, which `MessageUnitModule` turns into the fork's `Tenant`, and
 * the relay's own side is `OUTBOX_TENANTS`, read by `outbox()` itself.
 * Everything else is read from the environment inside the graph, so `main.ts`
 * boots this value as is and the specs boot it with `env` pointing at each
 * test's own vhost.
 */
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    mailer({ adapter: smtpMailer() }),
    storage({ adapter: s3Storage() }),
    observability({ sink: logSink }),
    otel(),
    outbox(),
  ],
  provides: [orderAmqpClient, orderPublisher],
  // The worker forks this once per delivery, after the message is validated —
  // which is where the envelope's `tenantId` becomes the fork's `Tenant`.
  unit: { message: MessageUnitModule },
  // Everything the fork reads out of the application scope, and the store a
  // spec reads the outbox back through.
  exports: [OutboxStore, OrderDatabase, Logger, Tracer],
});
