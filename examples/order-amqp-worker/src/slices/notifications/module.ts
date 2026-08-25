import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { Mailer } from "@btravstack/mailer";

import { orderNotifications } from "./handler.js";

/**
 * The notifications slice: one consumer, its handler, and nothing else the
 * rest of the worker can see.
 *
 * Unlike `order-api`'s slices it imports no vertical, and that is the honest
 * shape rather than a weaker one: a subscriber reacts to a fact somebody else
 * committed, so it owns no domain and no persistence. What a slice buys here
 * is that each consumer declares the ports IT calls — this one takes `Logger`
 * and `Mailer`, and knows nothing of the audit slice's.
 *
 * `exports: [orderNotifications]` is the provider, not a port class:
 * `AmqpHandler` mints the port from the contract key, so there is nothing to
 * name.
 */
export const NotificationsSlice = Module("NotificationsSlice")({
  needs: [Logger, Mailer],
  provides: [orderNotifications],
  exports: [orderNotifications],
});
