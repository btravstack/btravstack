import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import type { AmqpInfo, AmqpRuntime } from "@btravstack/amqp";
import type { Env } from "@btravstack/config";
import type { RunningApp } from "@btravstack/core";
import { Provider, type Module, type Scope } from "@btravstack/di";
import { OrderRepository, Outbox, PlaceOrder } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { uuidv7 } from "@btravstack/internal-test-infra/uuid";
import { Logger, LoggerConfig, createLogger, type Line } from "@btravstack/observability";
import { bootFixture, overridden, tapped, type Boot } from "@btravstack/testing";
import { inject, type TestAPI } from "vitest";

import { OrderAmqpWorker } from "./module.js";

type App<E> = RunningApp<E, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number };

/**
 * `X` is pinned to the ports the composition root exports rather than left
 * generic: `start`'s gate is a marker intersected onto `module`, proven at the
 * call site, and no proof is available inside a helper generic in the module's
 * own exports. `AmqpRuntime` is what `start` resolves; the rest is the writer's
 * surface, which the tap below reads. Spelled inline, like
 * `order-temporal-worker`'s: an alias for a port union reads like a domain
 * concept and is neither — the list IS the meaning.
 */
type Serve = <E>(
  module: Module<AmqpRuntime | PlaceOrder | OrderRepository | Outbox, E, Scope | Env>,
  options?: ServeOptions,
) => Promise<App<E>>;

/**
 * `OrderAmqpWorker` ITSELF, with a recording logger overridden in — not a
 * parallel root any more. `observability({ sink })` used to force one:
 * nothing can be layered over a graph that already provides `Logger`, so
 * this fixture restated the whole root and drifted from it by hand (issue
 * #63; PR #49 is where the drift bit). `overridden` replaces the `Logger`
 * provider inside the real root instead — reading the real `LoggerConfig`,
 * so `LOG_LEVEL` filters exactly as in production — and an override the
 * root stops backing is a loud `WiringDefect`, which is the sync-by-hand
 * this comment used to ask for, made mechanical.
 *
 * `start` hands the application context to the runtime alone, so a spec still
 * cannot reach the *services* the way `Module.scoped` can:
 * `@btravstack/testing`'s `tapped` captures the very instances the running app
 * uses — the writer the spec places orders through and the outbox
 * it asserts against.
 */
const tappedAmqp = () => {
  const lines: Line[] = [];
  const recording = overridden(OrderAmqpWorker, [
    Provider(Logger)(
      { config: LoggerConfig },
      { sync: ({ config }) => createLogger((line) => lines.push(line), config.level) },
    ),
  ]);
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
  /**
   * This test's tenant, and nobody else's. The database is shared by every
   * workspace's run — one migration for the whole gate rather than one per
   * test — so a UUID here is what separates this test's orders from the rest.
   * It is what `OUTBOX_TENANTS` points the relay at, and what every write in a
   * spec names, because the ports say so.
   */
  readonly tenant: TenantId;
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

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tenant: async ({}, use) => {
    await use(TenantId(uuidv7()));
  },

  serve: async ({ amqpConnectionUrl, tenant, boot }, use) => {
    // `OUTBOX_POLL_MS` tight on purpose: the specs wait on real broker round
    // trips, and a production-sized idle sleep would be most of every test's
    // clock. `OUTBOX_TENANTS` is this test's alone, so the relay sweeps its
    // own rows and never another test's on the shared database.
    const env = {
      AMQP_URL: amqpConnectionUrl,
      DATABASE_URL: inject("__ORDERS_DATABASE_URL__"),
      OUTBOX_POLL_MS: "25",
      OUTBOX_TENANTS: tenant,
    };

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
