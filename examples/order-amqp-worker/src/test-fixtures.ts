import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import type { AmqpInfo } from "@btravstack/start-amqp";
import { start, type RunningApp } from "@btravstack/start-core";
import { orderContract } from "@btravstack/start-example-order-amqp-contract";
import { Logger, Outbox, PlaceOrder } from "@btravstack/start-example-order-application";
import { expect, type TestAPI } from "vitest";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { OrderAmqpModule } from "./module.js";

type App<E> = RunningApp<E, AmqpInfo>;

/**
 * `X` is pinned to the three ports the composition root exports rather than
 * left generic: `start`'s needs gate is a phantom rest parameter proven at the
 * call site, and no proof is available inside a helper generic in the module's
 * own exports. The runtime needs two of them; `PlaceOrder` is the writer's.
 */
type AmqpPorts = PlaceOrder | Outbox | Logger;

type ServeOptions = { readonly drainTimeoutMs: number };

type Serve = <E>(module: Module<AmqpPorts, E, Scope>, options?: ServeOptions) => Promise<App<E>>;

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach the services the way `Module.scoped` can. This captures the very
 * instances the running app uses — the writer the spec places orders through
 * (the same database the relay sweeps, which for `:memory:` SQLite is the
 * whole point), the outbox it asserts against, and the logger the consumer
 * writes its notification lines to.
 */
class ServicesTap extends Port("ServicesTap")<{
  readonly placeOrder: ServiceOf<PlaceOrder>;
  readonly outbox: ServiceOf<Outbox>;
  readonly logger: ServiceOf<Logger>;
}> {}

const tappedAmqp = () => {
  let services: ServiceOf<ServicesTap> | undefined;

  return {
    module: Module("TappedAmqp")({
      imports: [OrderAmqpModule],
      provides: [
        Provider(ServicesTap)([PlaceOrder, Outbox, Logger], {
          sync: (placeOrder, outbox, logger) => {
            services = { placeOrder, outbox, logger };
            return services;
          },
        }),
      ],
      exports: [PlaceOrder, Outbox, Logger],
    }),
    services: (): ServiceOf<ServicesTap> => {
      // oxlint-disable-next-line unthrown/no-throw -- a fixture misused before `serve` is a broken test, and the loudest possible answer is the right one
      if (services === undefined) throw new Error("the app has not been served yet");
      return services;
    },
  };
};

export type AmqpFixtures = {
  /**
   * Boots an app whose relay publishes to — and whose consumer reads from —
   * this test's own vhost, and registers its shutdown. The teardown runs even
   * when the test fails, and it keeps the assertion the old `try`/`finally`
   * blocks carried: the app exited `Ok`.
   */
  readonly serve: Serve;
  readonly tapped: ReturnType<typeof tappedAmqp>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  serve: async ({ amqpConnectionUrl }, use) => {
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: Serve = async (module, options) => {
      const app = start(module, {
        runtime: orderAmqpRuntime({
          contract: orderContract,
          urls: [amqpConnectionUrl],
          // Tight on purpose: the specs wait on real broker round trips, and
          // a production-sized idle sleep would be most of every test's clock.
          relay: { pollMs: 25 },
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        ...options,
      });
      shutdowns.push(async () => {
        app.stop();
        await expect(app.exited).toBeOk();
      });
      // `runtimeInfo()` resolves once the worker is consuming — await it here
      // so the caller's test body never races the worker's own startup.
      await app.runtimeInfo();
      return app;
    };

    await use(serve);

    for (const shutdown of shutdowns) await shutdown();
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tapped: async ({}, use) => {
    await use(tappedAmqp());
  },
});
