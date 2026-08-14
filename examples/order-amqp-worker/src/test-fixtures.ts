import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import { Config } from "@btravstack/config";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import type { AmqpInfo } from "@btravstack/start-amqp";
import { start, type RunningApp } from "@btravstack/start-core";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";
import { expect, type TestAPI } from "vitest";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { amqpConfig } from "./config.js";
import { outboxRelayConfig } from "./outbox-relay.js";

type App<E> = RunningApp<E, AmqpInfo>;

/**
 * `X` is pinned to the ports the composition root exports rather than left
 * generic: `start`'s needs gate is a phantom rest parameter proven at the call
 * site, and no proof is available inside a helper generic in the module's own
 * exports. The runtime needs four of them; `PlaceOrder` is the writer's.
 */
type AmqpPorts =
  | PlaceOrder
  | OrderRepository
  | Outbox
  | Logger
  | InstanceType<typeof amqpConfig>
  | InstanceType<typeof outboxRelayConfig>;

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
  readonly repository: ServiceOf<OrderRepository>;
  readonly outbox: ServiceOf<Outbox>;
  readonly logger: ServiceOf<Logger>;
}> {}

/**
 * The composition root `OrderAmqpModule` is, with one import swapped: this
 * test's own `Config.source` in place of `Config.source(process.env)`. The
 * broker is a per-test vhost and the relay's sweep is tight enough for a test
 * clock, and neither is a `Provider` stub — the configs parse their own
 * declared shapes, from a record a spec wrote instead of one the operating
 * system did.
 *
 * Spelled out rather than layered over `OrderAmqpModule`, because two
 * providers for one port is a wiring bug in di: a graph gets exactly one
 * `ConfigSource`, and this is the one.
 */
const tappedAmqp = (url: string) => {
  let services: ServiceOf<ServicesTap> | undefined;

  return {
    module: Module("TappedAmqp")({
      imports: [
        ApplicationModule,
        PersistenceModule,
        amqpConfig,
        outboxRelayConfig,
        // Tight on purpose: the specs wait on real broker round trips, and a
        // production-sized idle sleep would be most of every test's clock.
        Config.source({ AMQP_URL: url, OUTBOX_POLL_MS: "25" }),
      ],
      provides: [
        Provider(ServicesTap)([PlaceOrder, OrderRepository, Outbox, Logger], {
          sync: (placeOrder, repository, outbox, logger) => {
            services = { placeOrder, repository, outbox, logger };
            return services;
          },
        }),
      ],
      exports: [PlaceOrder, OrderRepository, Outbox, Logger, amqpConfig, outboxRelayConfig],
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
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; the broker URL now reaches the runtime through `tapped`'s config, not through here
  serve: async ({}, use) => {
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: Serve = async (module, options) => {
      const app = start(module, {
        runtime: orderAmqpRuntime(),
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

  tapped: async ({ amqpConnectionUrl }, use) => {
    await use(tappedAmqp(amqpConnectionUrl));
  },
});
