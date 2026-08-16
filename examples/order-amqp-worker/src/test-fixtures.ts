import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import { AmqpModule, type AmqpInfo, type AmqpRuntime } from "@btravstack/amqp";
import type { Env } from "@btravstack/config";
import type { RunningApp } from "@btravstack/core";
import type { Module, Scope } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  ApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { observability, type Line } from "@btravstack/observability";
import { bootFixture, tapped, type Boot } from "@btravstack/testing";
import type { TestAPI } from "vitest";

import { orderHandlers } from "./handlers.js";
import { outboxRelay, relayConfig } from "./outbox-relay.js";

type App<E> = RunningApp<E, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number };

/**
 * `X` is pinned to the ports the composition root exports rather than left
 * generic: `start`'s gate is a phantom rest parameter proven at the call site,
 * and no proof is available inside a helper generic in the module's own
 * exports. `AmqpRuntime` is what `start` resolves; the rest is the writer's
 * surface, which the tap below reads. Spelled inline, like
 * `order-temporal-worker`'s: an alias for a port union reads like a domain
 * concept and is neither — the list IS the meaning.
 */
type Serve = <E>(
  module: Module<AmqpRuntime | PlaceOrder | OrderRepository | Outbox, E, Scope | Env>,
  options?: ServeOptions,
) => Promise<App<E>>;

/**
 * The composition root's own shape, with a recording sink in place of stdout —
 * a parallel root rather than `OrderAmqpWorker` itself because nothing can be
 * layered over a graph that already provides `Logger`, and
 * `observability({ sink })` is the seam. What the consumer said comes back as
 * `Line` values, so no tap is needed for it at all.
 *
 * `start` hands the application context to the runtime alone, so a spec still
 * cannot reach the *services* the way `Module.scoped` can:
 * `@btravstack/testing`'s `tapped` captures the very instances the running app
 * uses — the writer the spec places orders through (the same database the
 * relay sweeps, which for `:memory:` SQLite is the whole point) and the outbox
 * it asserts against.
 */
const tappedAmqp = () => {
  const lines: Line[] = [];
  const recording = AmqpModule("RecordingAmqpWorker")({
    contract: orderContract,
    handlers: orderHandlers,
    imports: [
      ApplicationModule,
      PersistenceModule,
      observability({ sink: (line) => lines.push(line) }),
    ],
    provides: [relayConfig, outboxRelay],
    exports: [PlaceOrder, OrderRepository, Outbox],
  });
  const tap = tapped(recording, [PlaceOrder, OrderRepository, Outbox]);
  return {
    module: tap.module,
    lines: (): readonly Line[] => lines,
    services: () => {
      const [placeOrder, repository, outbox] = tap.services();
      return { placeOrder, repository, outbox };
    },
  };
};

export type AmqpFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /** Boots an app against this test's own vhost, through `boot` — so its shutdown is the fixture's. */
  readonly serve: Serve;
  /**
   * The composition root's shape, plus a tap on the very service instances it
   * runs and every line its logger wrote. `serve` points it at this test's own
   * vhost — its relay publishes to, and its consumer reads from, a broker no
   * other test shares.
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
