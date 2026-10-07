import { setTimeout as delay } from "node:timers/promises";

import { TypedAmqpClient } from "@amqp-contract/client";
import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import type { AmqpInfo, AmqpRuntime } from "@btravstack/amqp-worker";
import type { Env } from "@btravstack/config";
import {
  currentUnit,
  Logger,
  type RunningApp,
  type StartOptions,
  type Tracer,
} from "@btravstack/core";
import { Module, Provider, type Context, type Scope } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  OrderApplicationModule,
  OrderRepository,
  PlaceOrder,
  tenantOf,
} from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { OrderDatabase, OrderTenantPersistence } from "@btravstack/example-order-infrastructure";
import { Mailer, type Mail } from "@btravstack/mailer";
import { LoggerConfig, createLogger, type Line } from "@btravstack/observability";
import { OutboxStore } from "@btravstack/outbox";
import { Storage, StorageBackend } from "@btravstack/storage";
import { bootFixture, overridden, tapped, type Boot } from "@btravstack/testing";
import { OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { uuidv7 } from "uuidv7";
import { inject, type TestAPI } from "vitest";

import { OrderAmqpWorker } from "../module.js";

type App<E> = RunningApp<E, AmqpInfo>;

type ServeOptions = Pick<StartOptions, "drainTimeoutMs" | "preDrainDelayMs">;

/**
 * `X` is pinned rather than left generic: `start`'s gate is proven at the call
 * site, and no proof is available inside a helper generic in the module's own
 * exports. Spelled inline, because an alias for a port union would read like a
 * domain concept and is not one — the list IS the meaning.
 */
type Serve = <E>(
  module: Module<
    AmqpRuntime | OutboxStore | Logger | Tracer | InstanceType<typeof OrderDatabase>,
    E,
    Scope | Env
  >,
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
/**
 * The real invoice store, with every `put` held back `ms` first — a store
 * slower to write than a withdrawal is to arrive.
 */
const slowStorage = (ms: number) =>
  Provider(Storage)({
    inject: { backend: StorageBackend },
    sync: ({ backend }) => ({
      ...backend,
      put: (key, bytes, options) =>
        fromSafePromise(delay(ms)).flatMap(() => backend.put(key, bytes, options)),
    }),
  });

const tappedAmqp = (slowPutMs?: number) => {
  const lines: Line[] = [];
  const recordingLogger = Provider(Logger)({
    inject: { config: LoggerConfig },
    sync: ({ config }) => createLogger((line) => lines.push(line), config.level),
  });
  const recording =
    slowPutMs === undefined
      ? overridden(OrderAmqpWorker, [recordingLogger])
      : overridden(OrderAmqpWorker, [recordingLogger, slowStorage(slowPutMs)]);
  const tap = tapped(recording, [OrderDatabase, Logger, OutboxStore]);
  return {
    module: tap.module,
    lines: (): readonly Line[] => lines,
    services: () => {
      const [db, , outbox] = tap.services();
      return { db, outbox };
    },
    /**
     * A writer's scope over the running app's own client, for one tenant: the
     * shape `order-api`'s `UserModule` and the temporal worker's
     * `ActivityUnitModule` have, hand-composed because this deployment forks
     * no unit that writes — a subscriber reacts to facts, it does not place
     * orders.
     */
    writerFor: (tenant: TenantId) => {
      const [db, logger] = tap.services();
      return Module("Writer")({
        imports: [tenantOf(tenant), OrderTenantPersistence, OrderApplicationModule],
        provides: [
          Provider(OrderDatabase)({ inject: {}, value: db }),
          Provider(Logger)({ inject: {}, value: logger }),
        ],
        exports: [PlaceOrder, OrderRepository],
      });
    },
  };
};

/**
 * The real root over a store whose `put` holds the invoice until the unit it
 * runs in is aborted, and a mailer that records instead of sending — so a
 * spec can let the drain deadline pass while an invoice is in flight and see
 * what the handler does next.
 */
const stalledAmqp = () => {
  const sent: Mail[] = [];
  let reached = false;
  const tap = tapped(
    overridden(OrderAmqpWorker, [
      Provider(Logger)({
        inject: { config: LoggerConfig },
        sync: ({ config }) => createLogger(() => undefined, config.level),
      }),
      Provider(Storage)({
        inject: {},
        value: {
          put: () => {
            reached = true;
            const signal = currentUnit()?.signal;
            return fromSafePromise(
              new Promise<void>((resolve) =>
                signal?.addEventListener("abort", () => resolve(), { once: true }),
              ),
            );
          },
          get: () => OkAsync({ bytes: new Uint8Array(), contentType: "text/plain" }),
          delete: () => OkAsync(),
          presignedUrl: () => OkAsync("http://invoices.test/stalled"),
          presignedUpload: () => OkAsync("http://invoices.test/stalled"),
        },
      }),
      Provider(Mailer)({
        inject: {},
        value: {
          send: (mail) => {
            sent.push(mail);
            return OkAsync();
          },
        },
      }),
    ]),
    [OrderDatabase, Logger],
  );
  return {
    module: tap.module,
    reached: (): boolean => reached,
    sent: (): readonly Mail[] => sent,
    place: (tenant: TenantId, id: string, quantity: number) => {
      const [db, logger] = tap.services();
      return Module.scoped(
        Module("Writer")({
          imports: [tenantOf(tenant), OrderTenantPersistence, OrderApplicationModule],
          provides: [
            Provider(OrderDatabase)({ inject: {}, value: db }),
            Provider(Logger)({ inject: {}, value: logger }),
          ],
          exports: [PlaceOrder],
        }),
        (ctx) => ctx.get(PlaceOrder).execute(id, quantity),
      );
    },
  };
};

/** One `orderChanged` envelope, as the wire carries it. */
type Announced = {
  readonly eventId: number;
  readonly tenantId: string;
  readonly kind: "order";
  readonly id: string;
  readonly occurredAt: string;
  readonly placedAt?: string;
  readonly placementId?: number;
  readonly payload: { readonly quantity: number } | null;
};

const announcing = (url: string) => (event: Announced) =>
  TypedAmqpClient.create({ contract: orderContract, urls: [url] }).flatMap((client) =>
    client.publish("orderChanged", event).flatMap(() => client.close()),
  );

/** What a Mailpit message looks like, narrowed to what this suite reads. */
type Delivered = {
  readonly To: readonly { readonly Address: string }[];
  readonly Subject: string;
  readonly Text: string;
};

export type AmqpFixtures = {
  /**
   * What the shared Mailpit received for a tenant, oldest first, so a spec
   * can prove the notification LEFT the process rather than that a stub was
   * called.
   */
  readonly delivered: (tenantId: string) => Promise<readonly Delivered[]>;
  /** The variables `s3Storage()` and the invoice retention read, pointed at the shared RustFS. */
  readonly s3Env: Readonly<Record<string, string>>;
  /** The lifecycle rules the shared bucket holds right now. */
  readonly bucketRules: () => Promise<readonly LifecycleRule[]>;
  /**
   * Publishes one `orderChanged` fact straight onto this test's vhost, past the
   * outbox — how a spec puts a delivery the relay would never produce in front
   * of the subscribers: a withdrawal overtaking its placement, or a placement
   * time no database default could give.
   */
  readonly announce: ReturnType<typeof announcing>;
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
  /** The root with an invoice store that stalls until the unit aborts, and a recording mailer. */
  readonly stalled: ReturnType<typeof stalledAmqp>;
  /** The composition root over an invoice store whose every write takes a second. */
  readonly slowInvoices: ReturnType<typeof tappedAmqp>;
  /**
   * Runs `use` in a scope holding this test's tenant, the repository bound to
   * it and the use cases over both — built from the running app's own client,
   * so what a writer commits is what the relay sweeps. Valid once `serve` has
   * booted the tapped module.
   */
  readonly writer: <A, E>(
    use: (ctx: Context<PlaceOrder | OrderRepository>) => AsyncResult<A, E>,
  ) => AsyncResult<A, E>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  announce: async ({ amqpConnectionUrl }, use) => {
    await use(announcing(amqpConnectionUrl));
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  s3Env: async ({}, use) => {
    await use({
      STORAGE_S3_ENDPOINT: inject("__TESTCONTAINERS_S3_ENDPOINT__"),
      STORAGE_S3_BUCKET: inject("__TESTCONTAINERS_S3_BUCKET__"),
      STORAGE_S3_ACCESS_KEY_ID: inject("__TESTCONTAINERS_S3_ACCESS_KEY__"),
      STORAGE_S3_SECRET_ACCESS_KEY: inject("__TESTCONTAINERS_S3_SECRET_KEY__"),
    });
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  bucketRules: async ({}, use) => {
    const client = new S3Client({
      endpoint: inject("__TESTCONTAINERS_S3_ENDPOINT__"),
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: inject("__TESTCONTAINERS_S3_ACCESS_KEY__"),
        secretAccessKey: inject("__TESTCONTAINERS_S3_SECRET_KEY__"),
      },
    });
    await use(async () => {
      const read = await client.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: inject("__TESTCONTAINERS_S3_BUCKET__"),
        }),
      );
      return read.Rules ?? [];
    });
    client.destroy();
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  delivered: async ({}, use) => {
    const api = inject("__TESTCONTAINERS_MAILPIT_API__");
    await use(async (tenantId) => {
      const to = `tenant-${tenantId}@example.test`;
      const response = await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
      const body = (await response.json()) as { readonly messages: readonly { ID: string }[] };
      // The search answers summaries, newest first; the text is on the message.
      return Promise.all(
        body.messages
          .toReversed()
          .map(
            async ({ ID }) =>
              (await (await fetch(`${api}/api/v1/message/${ID}`)).json()) as Delivered,
          ),
      );
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
      // The shared RustFS; the tenant in every invoice key is what separates
      // this test's objects from the rest of the bucket.
      STORAGE_S3_ENDPOINT: inject("__TESTCONTAINERS_S3_ENDPOINT__"),
      STORAGE_S3_BUCKET: inject("__TESTCONTAINERS_S3_BUCKET__"),
      STORAGE_S3_ACCESS_KEY_ID: inject("__TESTCONTAINERS_S3_ACCESS_KEY__"),
      STORAGE_S3_SECRET_ACCESS_KEY: inject("__TESTCONTAINERS_S3_SECRET_KEY__"),
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

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  stalled: async ({}, use) => {
    await use(stalledAmqp());
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  slowInvoices: async ({}, use) => {
    await use(tappedAmqp(1_000));
  },

  writer: async ({ tenant, tapped }, use) => {
    await use((run) => Module.scoped(tapped.writerFor(tenant), run));
  },
});
