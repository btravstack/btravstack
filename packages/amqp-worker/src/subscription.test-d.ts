import {
  defineContract,
  defineEventConsumer,
  defineEventPublisher,
  defineExchange,
  defineMessage,
  defineQueue,
} from "@amqp-contract/contract";
import { HealthChecks, start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";
import { z } from "zod";

import { amqpSubscription } from "./subscription.js";

class Settings extends Port("SubscriptionTypeSettings")<{ readonly url: string }> {}
class EvictionFailed extends TaggedError("EvictionFailed") {}
class Cache extends Port("SubscriptionTypeCache")<{
  readonly evict: (tenantId: string) => AsyncResult<void, EvictionFailed>;
}> {}

const event = defineEventPublisher(
  defineExchange("type-events"),
  defineMessage(z.object({ tenantId: z.string() })),
  { routingKey: "changed" },
);
const queue = defineQueue("type-subscription", {
  type: "classic",
  durable: false,
  exclusive: true,
  autoDelete: true,
  retry: { mode: "none" },
  onPoison: "drop",
});
const contract = defineContract({ consumers: { changed: defineEventConsumer(event, queue) } });

const subscription = amqpSubscription("typed", {
  contract,
  settings: Settings,
  inject: { cache: Cache },
  sync: ({ cache }) => ({ changed: ({ input }) => cache.evict(input.payload.tenantId) }),
});

// @ts-expect-error -- the subscription carries its settings and handler dependencies to its application root
Module.scoped(subscription, () => OkAsync());

Module.scoped(
  Module("SubscriptionTypeRoot")({
    imports: [subscription],
    provides: [
      Provider(Settings)({ inject: {}, value: { url: "amqp://localhost" } }),
      Provider(Cache)({ inject: {}, value: { evict: () => ErrAsync(new EvictionFailed()) } }),
    ],
    exports: [HealthChecks],
  }),
  (ctx) => OkAsync(ctx.get(HealthChecks)),
);

// @ts-expect-error -- a subscription is a resource and does not export a runtime
start(subscription);

amqpSubscription("wrong-input", {
  contract,
  settings: Settings,
  sync: () => ({
    changed: ({ input }) => {
      // @ts-expect-error -- the event's payload is inferred from its contract
      const tenant: number = input.payload.tenantId;
      void tenant;
    },
  }),
});
