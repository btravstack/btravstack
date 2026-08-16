import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import type { AmqpInfo, AmqpRuntime } from "@btravstack/amqp";
import type { Env } from "@btravstack/config";
import type { RunningApp } from "@btravstack/core";
import type { Module, Scope } from "@btravstack/di";
import { Logger, OrderRepository, Outbox, PlaceOrder } from "@btravstack/example-order-application";
import { bootFixture, tapped, type Boot } from "@btravstack/testing";
import type { TestAPI } from "vitest";

import { OrderAmqpWorker } from "./module.js";

type App<E> = RunningApp<E, AmqpInfo>;

/**
 * `X` is pinned to the ports the composition root exports rather than left
 * generic: `start`'s gate is a phantom rest parameter proven at the call site,
 * and no proof is available inside a helper generic in the module's own
 * exports. `AmqpRuntime` is what `start` resolves; the rest is the writer's
 * surface, which the tap below reads.
 */
type AmqpPorts = AmqpRuntime | PlaceOrder | OrderRepository | Outbox | Logger;

type ServeOptions = { readonly drainTimeoutMs: number };

type Serve = <E>(
  module: Module<AmqpPorts, E, Scope | Env>,
  options?: ServeOptions,
) => Promise<App<E>>;

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach the services the way `Module.scoped` can. `@btravstack/testing`'s
 * `tapped` captures the very instances the running app uses — the writer the
 * spec places orders through (the same database the relay sweeps, which for
 * `:memory:` SQLite is the whole point), the outbox it asserts against, and
 * the logger the consumer writes its notification lines to.
 */
const tappedAmqp = () => {
  const tap = tapped(OrderAmqpWorker, [PlaceOrder, OrderRepository, Outbox, Logger]);
  return {
    module: tap.module,
    services: () => {
      const [placeOrder, repository, outbox, logger] = tap.services();
      return { placeOrder, repository, outbox, logger };
    },
  };
};

export type AmqpFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /** Boots an app against this test's own vhost, through `boot` — so its shutdown is the fixture's. */
  readonly serve: Serve;
  /**
   * The composition root, plus a tap on the very service instances it runs.
   * `serve` points it at this test's own vhost — its relay publishes to, and
   * its consumer reads from, a broker no other test shares.
   */
  readonly tapped: ReturnType<typeof tappedAmqp>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  boot: bootFixture(),
  serve: async ({ amqpConnectionUrl, boot }, use) => {
    // `OUTBOX_POLL_MS` tight on purpose: the specs wait on real broker round
    // trips, and a production-sized idle sleep would be most of every test's clock.
    const env = { AMQP_URL: amqpConnectionUrl, OUTBOX_POLL_MS: "25" };

    await use(async (module, options) => {
      const app = boot(module, { env, ...options });
      // `runtimeInfo()` resolves once the worker is consuming — await it here
      // so the caller's test body never races the worker's own startup.
      await app.runtimeInfo();
      return app;
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tapped: async ({}, use) => {
    await use(tappedAmqp());
  },
});
