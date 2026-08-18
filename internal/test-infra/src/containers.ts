import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { withLock } from "./lock.js";

/**
 * Every container this module starts carries it, so a contributor can find
 * and remove the whole set with one command — see this workspace's README.
 */
const LABEL = "com.btravstack.test-infra";

/**
 * The credentials and the two database names are constants rather than
 * configuration: the server is a test fixture nothing outside this repository
 * connects to, and a value that never changes is not config (root
 * `CLAUDE.md`, "no config for a value that never changes").
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
 * `withReuse()` is what makes the second, third and fourth run find the
 * container instead of starting one — testcontainers hashes the creation
 * options and fetches by that hash — and {@link withLock} is what makes the
 * lookup safe when turbo starts those runs concurrently. The consequence is
 * deliberate: a reused container is not registered with Ryuk, so it outlives
 * the run. That is the trade the repository takes — a warm container costs
 * nothing to attach to, and a cold one costs the image pull that made
 * `pnpm test` intermittently red.
 */
const shared = (name: string, define: () => GenericContainer): Promise<StartedTestContainer> =>
  withLock(name, () =>
    define()
      .withReuse()
      .withLabels({ [LABEL]: name })
      .start(),
  );

/**
 * The one database server: Temporal's persistence and the example
 * application's schema, side by side on it. Two databases on one server
 * rather than two servers, which is the whole reason the application's tests
 * no longer need SQLite.
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

  // PostgreSQL has no `CREATE DATABASE IF NOT EXISTS`, and a reused server
  // already has this one — so the existence check is the guard, and `psql`
  // inside the image is what runs it rather than a `pg` dependency here.
  await withLock(`postgres-${ORDERS_DATABASE}`, async () => {
    const create = `psql -U ${POSTGRES_USER} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${ORDERS_DATABASE}'" | grep -q 1 || psql -U ${POSTGRES_USER} -d postgres -c 'CREATE DATABASE ${ORDERS_DATABASE}'`;
    const { exitCode, output } = await postgres.exec(["sh", "-c", create]);
    if (exitCode !== 0)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here
      throw new Error(`Could not create the '${ORDERS_DATABASE}' database: ${output}`);
  });

  return postgres;
};

/**
 * A libpq URL for one database on the shared server, as
 * `@prisma/adapter-pg` and `prisma migrate deploy` both take it.
 */
export const postgresUrl = (postgres: StartedTestContainer, database: string): string =>
  `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/${database}`;

/**
 * The broker both AMQP workspaces consume. Each *test* still gets its own
 * vhost — `@amqp-contract/testing`'s `it` extension mints one per test from
 * the management API — so sharing the server costs no isolation at all; what
 * it removes is the second image pull and the second 60s startup wait racing
 * the first.
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
 * The Temporal server, backed by {@link sharedPostgres}.
 *
 * It reaches PostgreSQL by container IP on the default bridge rather than
 * through a testcontainers `Network`: a network is created with a fresh
 * random name every run and torn down with the session, so a *reused*
 * container would be left attached to a network that no longer exists. An IP
 * on the default bridge is stable for as long as the container is, which is
 * exactly the lifetime reuse gives it — and it is part of the reuse hash, so
 * a PostgreSQL container that comes back at a different address produces a
 * matching new Temporal container rather than a silently broken one.
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
