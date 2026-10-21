import {
  TypedAmqpWorker,
  type ConnectionError,
  type WorkerInferConsumerHandler,
} from "@amqp-contract/worker";
import {
  HealthChecks,
  HealthCheckFailed,
  Observers,
  noObserverMember,
  observe,
} from "@btravstack/core";
import {
  Module,
  Port,
  Provider,
  type AnyPort,
  type PortClassOf,
  type Scope,
  type ServiceOf,
} from "@btravstack/di";
import {
  ErrAsync,
  Ok,
  OkAsync,
  TaggedError,
  fromSafePromise,
  type AsyncResult,
  type Result,
} from "unthrown";

import type { AnyAmqpContract } from "./amqp-runtime.js";
import { brokerLog } from "./broker-log.js";

/** A subscription requires explicitly ephemeral queues with no retry or dead-letter routing. */
export class InvalidAmqpSubscription extends TaggedError("InvalidAmqpSubscription")<{
  readonly subscription: string;
}> {
  override message =
    "subscriptions require consumers on exclusive auto-delete non-durable classic queues with no retry or dead letter, and no RPCs";
}

/** Best-effort handlers retain their contract's typed input and may run synchronously. */
export type SubscriptionHandlers<C extends AnyAmqpContract, E> = {
  readonly [K in C["consumers"] extends Record<string, unknown> ? keyof C["consumers"] : never]: (
    ...args: Parameters<WorkerInferConsumerHandler<C, K>>
  ) => void | Result<void, E> | AsyncResult<void, E>;
};

/**
 * Consume broadcast facts for the application scope's lifetime, beside its one
 * runtime. Every validated delivery is acknowledged, including handler failures;
 * failures are reported to Observers. Each replica must name its own queues.
 */
export const amqpSubscription = <
  C extends AnyAmqpContract,
  Settings extends { readonly url: string; readonly connectTimeoutMs?: number },
  const SettingsId extends string,
  E,
  const D extends Readonly<Record<string, AnyPort>> = Record<never, never>,
>(
  name: string,
  options: {
    readonly contract: C;
    readonly settings: PortClassOf<SettingsId, Settings>;
    readonly inject?: D;
    readonly sync: (services: {
      readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
    }) => SubscriptionHandlers<C, E>;
  } & ([keyof D] extends [never] ? unknown : { readonly inject: D }),
): Module<
  HealthChecks,
  ConnectionError | InvalidAmqpSubscription,
  InstanceType<PortClassOf<SettingsId, Settings>> | InstanceType<D[keyof D]> | Scope
> => {
  const resource = Port(`AmqpSubscription:${name}`)<TypedAmqpWorker<C>>;
  return Module(`AmqpSubscription:${name}`)({
    provides: [
      noObserverMember,
      Provider(resource)({
        inject: {
          settings: options.settings,
          observers: Observers,
          ...Object.fromEntries(
            Object.entries(options.inject ?? {}).map(([key, port]) => [`dependency:${key}`, port]),
          ),
        },
        acquire: (services) => {
          const consumers = Object.values(options.contract.consumers ?? {});
          if (
            consumers.length === 0 ||
            Object.keys(options.contract.rpcs ?? {}).length > 0 ||
            consumers.some(
              ({ queue }) =>
                queue.type !== "classic" ||
                queue.durable ||
                queue.exclusive !== true ||
                queue.autoDelete !== true ||
                queue.retry.mode !== "none" ||
                queue.deadLetter !== undefined ||
                queue.arguments?.["x-dead-letter-exchange"] !== undefined,
            )
          )
            return ErrAsync(new InvalidAmqpSubscription({ subscription: name }));
          const dependencies = Object.fromEntries(
            Object.keys(options.inject ?? {}).map((key) => [
              key,
              (services as Readonly<Record<string, unknown>>)[`dependency:${key}`],
            ]),
          ) as { readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>> };
          const handlers = options.sync(dependencies) as Readonly<
            Record<
              string,
              (helpers: unknown, message: unknown) => void | Result<void, E> | AsyncResult<void, E>
            >
          >;
          const observers = services.observers;
          const wrapped = Object.fromEntries(
            Object.entries(handlers).map(([key, handler]) => [
              key,
              (...args: Parameters<typeof handler>) => {
                const settle = observe(observers, {
                  component: "amqp",
                  name: "subscription",
                  attributes: { subscription: name, consumer: key },
                });
                return fromSafePromise(
                  (async () => {
                    const result = await OkAsync().flatMap(() => handler(...args) ?? Ok());
                    settle(
                      result.isOk()
                        ? { outcome: "ok" }
                        : { outcome: "error", cause: result.isErr() ? result.error : result.cause },
                    );
                  })(),
                );
              },
            ]),
          );
          return TypedAmqpWorker.create({
            contract: options.contract,
            handlers: wrapped as never,
            urls: [services.settings.url],
            connectTimeoutMs: services.settings.connectTimeoutMs ?? 5_000,
            logger: brokerLog(observers),
          });
        },
        release: (worker) => worker.close().get(),
      }),
      Provider.member(HealthChecks)({
        inject: { worker: resource },
        sync: ({ worker }) => ({
          name: `amqp-subscription:${name}`,
          check: () =>
            worker.isConnected()
              ? OkAsync()
              : ErrAsync(new HealthCheckFailed({ reason: "broker disconnected" })),
        }),
      }),
    ],
    exports: [HealthChecks],
  }) as never;
};
