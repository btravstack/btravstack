import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import type { AmqpInfo, AmqpRuntime } from "@btravstack/amqp-worker";
import type { Env } from "@btravstack/config";
import { type RunningApp, Logger } from "@btravstack/core";
import { Provider, type Module, type Scope } from "@btravstack/di";
import { OrderRepository, Outbox, PlaceOrder } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { LoggerConfig, createLogger, type Line } from "@btravstack/observability";
import { bootFixture, overridden, tapped, type Boot } from "@btravstack/testing";
import { uuidv7 } from "uuidv7";
import { inject, type TestAPI } from "vitest";

import { OrderAmqpWorker } from "../module.js";

type App<E> = RunningApp<E, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number };

/**
 * `X` is pinned rather than left generic: `start`'s gate is proven at the call
 * site, and no proof is available inside a helper generic in the module's own
 * exports. Spelled inline, because an alias for a port union would read like a
 * domain concept and is not one — the list IS the meaning.
 */
type Serve = <E>(
  module: Module<AmqpRuntime | PlaceOrder | OrderRepository | Outbox, E, Scope | Env>,
  options?: ServeOptions,
) => Promise<App<E>>;

/**
 * `OrderAmqpWorker` ITSELF, with a recording logger overridden in rather than a
 * parallel root restated by hand: `overridden` replaces the `Logger` provider
 * inside the real one, and an override the root stops backing is a loud
 * `WiringDefect`.
 *
 * `start` hands the application context to the runtime alone, so `tapped` is
 * what captures the very instances the running app uses.
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

/** What a Mailpit message looks like, narrowed to what this suite reads. */
type Delivered = { readonly To: readonly { readonly Address: string }[]; readonly Subject: string };

export type AmqpFixtures = {
  /**
   * What the shared Mailpit received for a tenant, so a spec can prove the
   * notification LEFT the process rather than that a stub was called.
   */
  readonly delivered: (tenantId: string) => Promise<readonly Delivered[]>;
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * This test's tenant, and nobody else's: the database is shared by every
   * workspace's run, so a UUID here separates this test's orders from the rest.
   * It is what `OUTBOX_TENANTS` points the relay at.
   */
  readonly tenant: TenantId;
  /** Boots an app against this test's own vhost, through `boot` — so its shutdown is the fixture's. */
  readonly serve: Serve;
  /**
   * The composition root's shape, plus a tap on the service instances it runs
   * and every line its logger wrote, pointed at this test's own vhost.
   */
  readonly tapped: ReturnType<typeof tappedAmqp>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  delivered: async ({}, use) => {
    const api = inject("__TESTCONTAINERS_MAILPIT_API__");
    await use(async (tenantId) => {
      const to = `tenant-${tenantId}@example.test`;
      const response = await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
      const body = (await response.json()) as { readonly messages: readonly Delivered[] };
      return body.messages;
    });
  },
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
      SMTP_URL: inject("__TESTCONTAINERS_SMTP_URL__"),
      OUTBOX_POLL_MS: "25",
      OUTBOX_TENANTS: tenant,
      // The real root composes otel(); a spec run stands up no collector, so
      // the SDK is disabled through its own switch — the ports still resolve.
      OTEL_SDK_DISABLED: "true",
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
