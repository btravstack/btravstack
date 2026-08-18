import type { TestProject } from "vitest/node";

import { sharedRabbitMq } from "./containers.js";
import type {} from "./vitest.js";

/**
 * The keys are `@amqp-contract/testing`'s own — its `it` extension `inject`s
 * exactly these five to build a connection URL and to call the management
 * API for a vhost per test. Providing them from here is what lets both AMQP
 * workspaces keep that extension unchanged while sharing one broker: this
 * module is a drop-in replacement for
 * `@amqp-contract/testing/global-setup`, which starts a container of its own
 * per vitest run and is the reason two of them raced.
 */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const rabbitmq = await sharedRabbitMq();

  provide("__TESTCONTAINERS_RABBITMQ_IP__", rabbitmq.getHost());
  provide("__TESTCONTAINERS_RABBITMQ_PORT_5672__", rabbitmq.getMappedPort(5672));
  provide("__TESTCONTAINERS_RABBITMQ_PORT_15672__", rabbitmq.getMappedPort(15672));
  provide("__TESTCONTAINERS_RABBITMQ_USERNAME__", "guest");
  provide("__TESTCONTAINERS_RABBITMQ_PASSWORD__", "guest");

  // Nothing to tear down: the container is reused, so stopping it here would
  // pull it out from under whichever workspace's run is still going.
  return () => {};
};
