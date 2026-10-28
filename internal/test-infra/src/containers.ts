import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";

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
/** The example application's, created by {@link sharedPostgres} and migrated by {@link migrateOrders}. */
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
 * A bridge network under a fixed name rather than testcontainers' own
 * `Network`, which mints a random one and registers it with Ryuk: a second
 * process could neither find it nor rely on it outliving the run that created it.
 */
export const ensureNetwork = (name: string): Promise<void> =>
  withLock(`network-${name}`, async () => {
    const client = await getContainerRuntimeClient();
    const exists = await client.network
      .getById(name)
      .inspect()
      .then(
        () => true,
        () => false,
      );
    if (exists) return;

    await client.network.create({
      Name: name,
      Driver: "bridge",
      Labels: { [TEST_INFRA_LABEL]: name },
    });
  });

/**
 * Attach a shared container to `network` under `alias`, without restarting
 * it: a network is joined at runtime, where an option on its definition would
 * change the hash `withReuse()` finds it by.
 */
export const joinNetwork = (
  network: string,
  container: StartedTestContainer,
  alias: string,
): Promise<void> =>
  withLock(`${network}-${alias}`, async () => {
    const client = await getContainerRuntimeClient();
    const { Containers } = (await client.network.getById(network).inspect()) as {
      readonly Containers?: Record<string, unknown>;
    };
    if (Containers?.[container.getId()] !== undefined) return;

    await client.network.getById(network).connect({
      Container: container.getId(),
      EndpointConfig: { Aliases: [alias] },
    });
  });

/**
 * A digest of files copied into a container. Copied content is not part of
 * what testcontainers hashes for reuse, so it rides a label, and an edited
 * file gets a new container rather than a reused one still serving the old copy.
 */
export const digest = async (...files: readonly URL[]): Promise<string> => {
  const contents = await Promise.all(files.map((file) => readFile(file)));
  return createHash("sha256").update(Buffer.concat(contents)).digest("hex").slice(0, 16);
};

/** The one database server, and the example application's schema on it. */
export const sharedPostgres = async (): Promise<StartedTestContainer> => {
  const postgres = await shared("postgres", () =>
    new GenericContainer("postgres:18.1")
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_DB: ORDERS_DATABASE,
        POSTGRES_USER,
        POSTGRES_PASSWORD,
      })
      .withHealthCheck({
        // Over TCP: the entrypoint's temporary init server answers the socket, then restarts.
        test: ["CMD-SHELL", `pg_isready -h 127.0.0.1 -U ${POSTGRES_USER}`],
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
 * the Prisma 8 client and `prisma db migrate` both take it.
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
/**
 * The schema the example's contract declares a `namespace` for. Every grant
 * below is scoped to it; nothing is granted on `public`.
 */
export const ORDERS_SCHEMA = "orders";

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
 * Run as the owner AFTER `prisma db migrate`, and the ordering is not
 * incidental: the migration is what CREATEs the `orders` schema, `ON ALL
 * TABLES` covers only what exists by then, and `ALTER DEFAULT PRIVILEGES` only
 * what the owner creates from here on. Idempotent, because a reused container
 * outlives the run.
 *
 * Every grant is scoped to the application's own schema rather than to
 * `public` — which is the point of the contract declaring a `namespace`: the
 * role can reach this application's tables and nothing else the database may
 * grow later.
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
      GRANT USAGE ON SCHEMA ${ORDERS_SCHEMA} TO ${ORDERS_APP_USER};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ORDERS_SCHEMA} TO ${ORDERS_APP_USER};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ORDERS_SCHEMA} TO ${ORDERS_APP_USER};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${ORDERS_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ORDERS_APP_USER};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${ORDERS_SCHEMA} GRANT USAGE, SELECT ON SEQUENCES TO ${ORDERS_APP_USER};
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

const run = promisify(execFile);

/** The one workspace this module knows by path: it owns the schema and the `prisma` CLI. */
const ordersInfrastructure = fileURLToPath(
  new URL("../../../examples/order-infrastructure", import.meta.url),
);

/**
 * Applies the example application's migrations with **`prisma db migrate`** —
 * the literal command a deployment runs — as the owner, provisions
 * {@link ORDERS_APP_USER}, and answers that role's URL: the owner's never
 * leaves here, because a superuser bypasses row security.
 *
 * The marker in `prisma_contract.marker` makes a second run a no-op, and
 * {@link withLock} stops the gate's runs and the dev loop racing to be first,
 * since they share one database and none may assume another ran first.
 */
export const migrateOrders = async (postgres: StartedTestContainer): Promise<string> => {
  await withLock("orders-migrate", () =>
    run("pnpm", ["exec", "prisma", "db", "migrate"], {
      cwd: ordersInfrastructure,
      env: { ...process.env, DATABASE_URL: postgresUrl(postgres, ORDERS_DATABASE) },
    }),
  );

  await provisionApplicationRole(postgres);

  return postgresUrl(postgres, ORDERS_DATABASE, {
    user: ORDERS_APP_USER,
    password: ORDERS_APP_PASSWORD,
  });
};

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
 * The AWS KMS emulator `@btravstack/keys`'s adapter is tested against: LocalStack
 * running KMS alone.
 *
 * Pinned to an exact release, the last line that starts without an account
 * token. Every behaviour the adapter relies on was measured against it before
 * the adapter was written: the encryption context enforced on `Decrypt`, and
 * the exception KMS names for a disabled key, a key pending deletion, a
 * missing alias and a ciphertext presented under another key.
 *
 * Tests separate by **alias**: each mints a KMS key of its own under a UUID
 * alias, which needs no cleanup.
 */
export const sharedLocalStack = (): Promise<StartedTestContainer> =>
  shared("localstack", () =>
    new GenericContainer("localstack/localstack:4.4.0")
      .withExposedPorts(4566)
      .withEnvironment({ SERVICES: "kms" })
      .withWaitStrategy(Wait.forLogMessage("Ready.")),
  );

/**
 * The Temporal server: the CLI's single-binary development server, in memory.
 * The same image and command as `@btravstack/temporal-testing`'s setup, so the
 * gate proves what consumers run.
 */
export const sharedTemporal = (): Promise<StartedTestContainer> =>
  shared("temporal", () =>
    new GenericContainer("temporalio/temporal:1.9.1")
      .withCommand(["server", "start-dev", "--ip", "0.0.0.0", "--headless"])
      .withExposedPorts(7233)
      .withHealthCheck({
        test: ["CMD", "temporal", "operator", "cluster", "health", "--address", "127.0.0.1:7233"],
        interval: 1_000,
        retries: 60,
        startPeriod: 1_000,
        timeout: 5_000,
      })
      .withWaitStrategy(Wait.forHealthCheck()),
  );

const TEMPORAL_TLS_NETWORK = "btravstack-temporal-tls";

const tlsFile = (name: string): URL => new URL(`./temporal-tls/${name}`, import.meta.url);

/**
 * nginx terminating TLS in front of {@link sharedTemporal}: port `7233`
 * requires a client certificate the test CA signed, and port `7234` a bearer
 * token starting `temporal-test-`. The starters' TLS specs connect through it,
 * to the same server and namespaces as every other spec — a proxy rather than
 * a second Temporal server, since the CLI's development server has no TLS.
 */
export const sharedTemporalTls = async (): Promise<StartedTestContainer> => {
  await ensureNetwork(TEMPORAL_TLS_NETWORK);
  const temporal = await sharedTemporal();
  await joinNetwork(TEMPORAL_TLS_NETWORK, temporal, "temporal");
  const files = ["nginx.conf", "ca.pem", "server-cert.pem", "server-key.pem"].map(tlsFile);
  const content = await digest(...files);

  return shared("temporal-tls", () =>
    new GenericContainer("nginx:1.29-alpine")
      .withNetworkMode(TEMPORAL_TLS_NETWORK)
      .withExposedPorts(7233, 7234)
      .withLabels({ "com.btravstack.temporal-tls-content": content })
      .withCopyFilesToContainer([
        { source: fileURLToPath(tlsFile("nginx.conf")), target: "/etc/nginx/nginx.conf" },
        ...["ca.pem", "server-cert.pem", "server-key.pem"].map((name) => ({
          source: fileURLToPath(tlsFile(name)),
          target: `/etc/nginx/tls/${name}`,
        })),
      ])
      .withWaitStrategy(Wait.forListeningPorts()),
  );
};
