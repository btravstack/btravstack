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
import { otel } from "@btravstack/observability/otel";

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
 * The composition root of the broadcast deployment — now a list of slices
 * plus what no slice owns: the orders vertical the outbox relay writes from
 * (`OrderApplicationModule` / `OrderPersistenceModule`, unchanged from before
 * the split — the vertical is the relay's, not either subscriber's),
 * `observability()`, and the relay itself. `@btravstack/amqp-worker`'s `AmqpModule`
 * sugar imports the starter over `orderHandlers`, provides it, and exports
 * `AmqpRuntime` for `start` to resolve; the outbox relay sits next to it as a
 * resourceful provider: both halves of the outbox pattern in one graph, each
 * built by di from the services it declares. `observability()` provides the
 * `Logger` every subscriber and the relay write to — `LOG_LEVEL`, JSON on
 * stdout, every line correlated with the delivery's own unit.
 *
 * `NotificationsSlice` and `AuditSlice` are both imported here because
 * `orderHandlers`'s pieces are di-discovered only through `imports` /
 * `provides`, never through a provider's own `deps` — dropping either import
 * leaves its piece's port unmet and `start` fails with a `WiringDefect`
 * naming it, not a compile error.
 *
 * The exports are this deployment's own selection: `PlaceOrder` /
 * `OrderRepository` / `Outbox` / `Logger` are the writer's surface — what a
 * writer in the same process (the specs; in production, `order-api` against
 * the same database) places and cancels orders through, and what the specs
 * tap. Both write paths leave the outbox an event, which is the property this
 * deployment exists to demonstrate.
 *
 * Tenancy is the CONTRACT's, not the transport's. The envelope carries
 * `tenantId`, so a subscriber reads it off the message it was already given
 * and `@btravstack/amqp-worker` knows nothing about tenants; the relay's own side is
 * `OUTBOX_TENANTS`, which says whose facts this deployment is allowed to
 * broadcast.
 *
 * A constant: the broker URL, the database and the relay's poll interval and
 * tenants are read from the environment inside the graph (`AmqpConfig` from
 * `AMQP_URL`, `DatabaseConfig` from `DATABASE_URL`, `RelayConfig` from
 * `OUTBOX_POLL_MS` / `OUTBOX_TENANTS`), so nothing has to be passed in — `main.ts` boots
 * this value as is, and the specs boot it with `env` pointing at each test's
 * own vhost.
 */
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  // This root provides `relayConfig` itself — `OUTBOX_POLL_MS` /
  // `OUTBOX_TENANTS` off the environment — so `Env` is its own provider's
  // need, not one inherited from the slices below.
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
  // `Tracer` beside `Logger` for the same reason: `UnitSpanModule`, passed
  // as `StartOptions.unit` in `main.ts`, reads it out of the application scope.
  exports: [PlaceOrder, OrderRepository, Outbox, Logger, Tracer],
});
