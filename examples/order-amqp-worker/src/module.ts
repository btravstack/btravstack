import { AmqpHandlers, AmqpModule } from "@btravstack/amqp";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  OrderApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger, observability } from "@btravstack/observability";

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
 * `observability()`, and the relay itself. `@btravstack/amqp`'s `AmqpModule`
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
 * A constant: the broker URL and the relay's poll interval are read from the
 * environment inside the graph (`AmqpConfig` from `AMQP_URL`, `RelayConfig`
 * from `OUTBOX_POLL_MS`), so nothing has to be passed in — `main.ts` boots
 * this value as is, and the specs boot it with `env` pointing at each test's
 * own vhost.
 */
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    NotificationsSlice,
    AuditSlice,
    observability(),
  ],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
