import { HealthChecks, Observers, type Settled } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync, fromSafePromise, TaggedError } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { amqpSubscription } from "./subscription.js";

describe("amqpSubscription", () => {
  it("delivers each fact to both replicas and observes acknowledged failures", async ({
    amqpConnectionUrl,
    publishMessage,
    subscriptionContract,
  }) => {
    // GIVEN two replicas, each holding an exclusive subscription queue
    const seen: string[] = [];
    const observations: Settled[] = [];
    const first = subscriptionContract();
    const second = subscriptionContract();
    const root = Module("Subscriptions")({
      imports: [
        amqpSubscription("first", {
          contract: first,
          settings: Settings,
          inject: { label: Label },
          sync: ({ label }) => ({
            changed: ({ input }) => {
              seen.push(`${label}:${input.payload.id}`);
            },
          }),
        }),
        amqpSubscription("second", {
          contract: second,
          settings: Settings,
          sync: () => ({
            changed: ({ input }) => {
              seen.push(`second:${input.payload.id}`);
              return ErrAsync(new EvictionFailed());
            },
          }),
        }),
      ],
      provides: [
        Provider(Settings)({ inject: {}, value: { url: amqpConnectionUrl } }),
        Provider(Label)({ inject: {}, value: "first" }),
        Provider.member(Observers)({
          inject: {},
          value: (operation) => (settled) => {
            if (operation.name === "subscription") observations.push(settled);
          },
        }),
      ],
      exports: [HealthChecks],
    });

    // WHEN one fact is broadcast
    const result = await Module.scoped(root, (ctx) =>
      fromSafePromise(
        (async () => {
          publishMessage({ exchange: "subscription-test", routingKey: "changed" }, { id: "42" });
          await vi.waitUntil(() => seen.length === 2 && observations.length === 2);
          const health = await Promise.all(ctx.get(HealthChecks).map((check) => check.check()));
          return {
            seen: seen.sort(),
            outcomes: observations.map((settled) => settled.outcome).sort(),
            healthy: health.every((result) => result.isOk()),
          };
        })(),
      ),
    );

    // THEN both replicas receive it independently and a failure is reported
    expect(result).toBeOkWith({
      seen: ["first:42", "second:42"],
      outcomes: ["error", "ok"],
      healthy: true,
    });
  });

  it("closes its broker connection with the application scope", async ({
    amqpConnectionUrl,
    subscriptionContract,
  }) => {
    // GIVEN a scoped subscription with its connectivity check
    const root = Module("SubscriptionLifecycle")({
      imports: [
        amqpSubscription("lifecycle", {
          contract: subscriptionContract(),
          settings: Settings,
          sync: () => ({ changed: () => {} }),
        }),
      ],
      provides: [Provider(Settings)({ inject: {}, value: { url: amqpConnectionUrl } })],
      exports: [HealthChecks],
    });
    // WHEN the scope closes and its retained check is asked about the connection
    const checks = (
      await Module.scoped(root, (ctx) => OkAsync(ctx.get(HealthChecks)))
    ).getOrThrow();
    const health = await checks[0]!.check();
    // THEN the connection was released
    expect(health).toBeErrTagged("HealthCheckFailed");
  });

  it("refuses durable worker queues before opening a connection", async ({
    amqpConnectionUrl,
    subscriptionContract,
  }) => {
    // GIVEN a subscription configured with a durable queue
    const root = Module("InvalidSubscription")({
      imports: [
        amqpSubscription("invalid", {
          contract: subscriptionContract(true),
          settings: Settings,
          sync: () => ({ changed: () => {} }),
        }),
      ],
      provides: [Provider(Settings)({ inject: {}, value: { url: amqpConnectionUrl } })],
      exports: [HealthChecks],
    });

    // WHEN the application scope opens
    const result = await Module.scoped(root, () => fromSafePromise(Promise.resolve()));

    // THEN a modeled startup failure names the subscription
    expect(result).toBeErrWith(
      expect.objectContaining({ _tag: "InvalidAmqpSubscription", subscription: "invalid" }),
    );
  });
});

class Label extends Port("SubscriptionTestLabel")<string> {}
class Settings extends Port("SubscriptionTestSettings")<{ readonly url: string }> {}
class EvictionFailed extends TaggedError("EvictionFailed") {}
