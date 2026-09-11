import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { withLock } from "./lock.js";

/**
 * Every container this module starts carries it, so a contributor can find
 * and remove the whole set with one command — see this workspace's README.
 */
export const TEST_INFRA_LABEL = "com.btravstack.test-infra";

/**
 * Constants rather than configuration: the server is a test fixture nothing
 * outside this repository connects to, and a value that never changes is not
 * config.
 */
export const POSTGRES_USER = "btravstack";
export const POSTGRES_PASSWORD = "btravstack";
/** Temporal's own persistence, created by `temporalio/auto-setup`'s schema tool. */
export const TEMPORAL_DATABASE = "temporal";
/** The example application's, created by {@link sharedPostgres} and migrated by its own global setup. */
export const ORDERS_DATABASE = "orders";

/**
 * Started once per machine and reused by every workspace's vitest run.
 *
 * `withReuse()` is what makes a later run attach instead of starting one, and
 * {@link withLock} is what makes the lookup safe when turbo starts those runs
 * concurrently. One consequence is deliberate: a reused container is not
 * registered with Ryuk, so it outlives the run.
 */
export const shared = (
  name: string,
  define: () => GenericContainer,
): Promise<StartedTestContainer> =>
  withLock(name, () =>
    define()
      .withReuse()
      .withLabels({ [TEST_INFRA_LABEL]: name })
      .start(),
  );

/**
 * The one database server: Temporal's persistence and the example application's
 * schema, side by side. Two databases on one server rather than two servers.
 */
export const sharedPostgres = async (): Promise<StartedTestContainer> => {
  const postgres = await shared("postgres", () =>
    new GenericContainer("postgres:18.1")
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_DB: TEMPORAL_DATABASE,
        POSTGRES_USER,
        POSTGRES_PASSWORD,
      })
      .withHealthCheck({
        test: ["CMD-SHELL", `pg_isready -U ${POSTGRES_USER}`],
        interval: 1_000,
        retries: 30,
        startPeriod: 1_000,
        timeout: 1_000,
      })
      .withWaitStrategy(Wait.forHealthCheck()),
  );

  await ensureDatabase(postgres, ORDERS_DATABASE);

  return postgres;
};

/**
 * PostgreSQL has no `CREATE DATABASE IF NOT EXISTS`, and a reused server
 * already has the database — so the existence check is the guard, and `psql`
 * inside the image is what runs it rather than a `pg` dependency here.
 */
export const ensureDatabase = (postgres: StartedTestContainer, database: string): Promise<void> =>
  withLock(`postgres-${database}`, async () => {
    const create = `psql -U ${POSTGRES_USER} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${database}'" | grep -q 1 || psql -U ${POSTGRES_USER} -d postgres -c 'CREATE DATABASE ${database}'`;
    const { exitCode, output } = await postgres.exec(["sh", "-c", create]);
    if (exitCode !== 0)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here
      throw new Error(`Could not create the '${database}' database: ${output}`);
  });

/**
 * A libpq URL for one database on the shared server, as
 * `@prisma/adapter-pg` and `prisma migrate deploy` both take it.
 *
 * Defaults to the bootstrap superuser, which is what applies the migrations.
 * The example application connects as {@link ORDERS_APP_USER} instead — pass
 * its credentials here rather than reaching for a second helper.
 */
export const postgresUrl = (
  postgres: StartedTestContainer,
  database: string,
  credentials: { readonly user: string; readonly password: string } = {
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
  },
): string =>
  `postgresql://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/${database}`;

/**
 * The role the example application connects to {@link ORDERS_DATABASE} as.
 *
 * Gate-only credentials, on the same footing as {@link POSTGRES_USER}: a value
 * nothing outside this repository connects with is not configuration.
 */
export const ORDERS_APP_USER = "orders_app";

/** That role's password, on the same gate-only terms. */
export const ORDERS_APP_PASSWORD = "orders_app";

/**
 * Creates {@link ORDERS_APP_USER} and grants it the whole `public` schema of
 * {@link ORDERS_DATABASE}.
 *
 * `NOSUPERUSER NOBYPASSRLS` is the point: a superuser bypasses row security
 * whatever `FORCE ROW LEVEL SECURITY` says, and the container's bootstrap user
 * is one — so a policy tested through it would pass while proving nothing.
 *
 * Run as the owner AFTER `prisma migrate deploy`: `ON ALL TABLES` covers only
 * what exists, and `ALTER DEFAULT PRIVILEGES` only what the owner creates from
 * here on. Idempotent, because a reused container outlives the run.
 */
export const provisionApplicationRole = (postgres: StartedTestContainer): Promise<void> =>
  withLock(`postgres-${ORDERS_APP_USER}`, async () => {
    // `psql` inside the image rather than a `pg` dependency here, the same
    // shape as the database creation above. `GRANT USAGE, SELECT ON ALL
    // SEQUENCES` is load-bearing: `Order.id` is `autoincrement()`, and without
    // it every insert fails with a permission error that reads nothing like an
    // RLS refusal.
    const ddl = `
      DO $$ BEGIN
        CREATE ROLE ${ORDERS_APP_USER} NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${ORDERS_APP_PASSWORD}';
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT CONNECT ON DATABASE ${ORDERS_DATABASE} TO ${ORDERS_APP_USER};
      GRANT USAGE ON SCHEMA public TO ${ORDERS_APP_USER};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ORDERS_APP_USER};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ORDERS_APP_USER};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ORDERS_APP_USER};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ORDERS_APP_USER};
    `;
    const { exitCode, output } = await postgres.exec([
      "psql",
      "-U",
      POSTGRES_USER,
      "-d",
      ORDERS_DATABASE,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      ddl,
    ]);
    if (exitCode !== 0)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here
      throw new Error(`Could not provision the '${ORDERS_APP_USER}' role: ${output}`);
  });

/**
 * The broker both AMQP workspaces consume. Each TEST still mints its own vhost,
 * so sharing the server costs no isolation — what it removes is the second image
 * pull and the second startup wait racing the first.
 */
export const sharedRabbitMq = (): Promise<StartedTestContainer> =>
  shared("rabbitmq", () =>
    new GenericContainer("rabbitmq:4.2.1-management-alpine")
      .withExposedPorts(5672, 15672)
      .withEnvironment({ RABBITMQ_DEFAULT_USER: "guest", RABBITMQ_DEFAULT_PASS: "guest" })
      .withWaitStrategy(
        Wait.forAll([Wait.forLogMessage(/Server startup complete/), Wait.forListeningPorts()]),
      ),
  );

/**
 * The cache server `@btravstack/cache`'s Redis adapter is tested against. Each
 * test mints a UUID key prefix, a finer boundary than a database index that
 * needs no cleanup.
 */
export const sharedRedis = (): Promise<StartedTestContainer> =>
  shared("redis", () =>
    new GenericContainer("redis:8.8.2-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(
        Wait.forAll([Wait.forLogMessage(/Ready to accept connections/), Wait.forListeningPorts()]),
      ),
  );

/**
 * The SMTP server `@btravstack/mailer`'s adapter is tested against, and the
 * API a spec reads the delivered mail back through.
 *
 * Mailpit accepts anything and delivers nowhere, which is the whole point: a
 * suite proving "this code would have sent that message" needs a transport
 * that answers like a real one and a mailbox it can query. Isolation is a
 * **recipient per test** — a UUID localpart — so nothing is purged between
 * tests and one suite cannot read another's mail.
 */
export const sharedMailpit = (): Promise<StartedTestContainer> =>
  shared("mailpit", () =>
    new GenericContainer("axllent/mailpit:v1.31.0")
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forListeningPorts()),
  );

/** What every S3 suite signs with. A test fixture nothing outside this repository reaches, so a constant rather than configuration. */
export const RUSTFS_ACCESS_KEY = "rustfsadmin";
export const RUSTFS_SECRET_KEY = "rustfsadmin";
/** The one bucket, created by {@link sharedRustFs}. Tests separate by key prefix inside it. */
export const RUSTFS_BUCKET = "btravstack";

/**
 * The S3-compatible object store `@btravstack/storage`'s adapter is tested
 * against.
 *
 * RustFS rather than MinIO, and pinned to an exact release candidate: the tag
 * is pre-1.0 and `latest` moves. Every operation the port needs was measured
 * against this image before the port was written — put with a content type,
 * get returning it, a presigned GET answering `200`, and a delete of a key
 * nobody stored answering ok.
 *
 * One bucket for the whole gate, with a **key prefix per test**: a bucket per
 * test would be a create-and-delete round trip bought for an isolation a
 * UUID prefix already gives for nothing.
 */
export const sharedRustFs = async (): Promise<StartedTestContainer> => {
  const rustfs = await shared("rustfs", () =>
    new GenericContainer("rustfs/rustfs:1.0.0-rc.3")
      .withExposedPorts(9000)
      .withEnvironment({
        RUSTFS_ACCESS_KEY,
        RUSTFS_SECRET_KEY,
      })
      .withWaitStrategy(Wait.forListeningPorts()),
  );

  // S3 has no "create if absent", and a reused container already has the
  // bucket — so the conflict IS the guard, the same shape as the `orders`
  // database above.
  await withLock(`rustfs-${RUSTFS_BUCKET}`, async () => {
    const endpoint = `http://${rustfs.getHost()}:${rustfs.getMappedPort(9000)}`;
    const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: RUSTFS_ACCESS_KEY, secretAccessKey: RUSTFS_SECRET_KEY },
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: RUSTFS_BUCKET }));
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
        // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here
        throw cause;
      }
    } finally {
      client.destroy();
    }
  });

  return rustfs;
};

/**
 * The Temporal server, backed by {@link sharedPostgres}.
 *
 * It reaches PostgreSQL by container IP on the default bridge rather than a
 * testcontainers `Network`, which is created with a fresh random name every run
 * and torn down with the session — so a REUSED container would be left attached
 * to a network that no longer exists. The IP is also part of the reuse hash, so
 * a PostgreSQL container at a new address produces a matching new Temporal one
 * rather than a silently broken pair.
 */
export const sharedTemporal = async (
  postgres: StartedTestContainer,
): Promise<StartedTestContainer> =>
  shared("temporal", () =>
    new GenericContainer("temporalio/auto-setup:1.29.1")
      .withExposedPorts(7233)
      .withEnvironment({
        DB: "postgres12",
        DB_PORT: "5432",
        POSTGRES_SEEDS: postgres.getIpAddress("bridge"),
        POSTGRES_USER,
        POSTGRES_PWD: POSTGRES_PASSWORD,
        BIND_ON_IP: "0.0.0.0",
        TEMPORAL_BROADCAST_ADDRESS: "127.0.0.1",
      })
      .withHealthCheck({
        test: ["CMD-SHELL", "tctl --address 127.0.0.1:7233 workflow list"],
        interval: 1_000,
        retries: 60,
        startPeriod: 1_000,
        timeout: 5_000,
      })
      .withWaitStrategy(Wait.forHealthCheck()),
  );
