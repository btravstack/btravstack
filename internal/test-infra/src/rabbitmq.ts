import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedRabbitMq } from "./containers.js";

/**
 * A setup module declares the keys it provides, and a workspace pulls in the
 * augmentation for exactly the setups its `vitest.config.ts` registers — so
 * the `import type` list in a `vitest.d.ts` mirrors the `globalSetup` list
 * beside it, and `inject` knows only what that run actually started.
 *
 * `import type {} from "vitest"` above is load-bearing: TypeScript can only
 * augment a module the program has already loaded, and nothing else here
 * imports vitest's root entry.
 */
declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_RABBITMQ_IP__: string;
    __TESTCONTAINERS_RABBITMQ_PORT_5672__: number;
    __TESTCONTAINERS_RABBITMQ_PORT_15672__: number;
    __TESTCONTAINERS_RABBITMQ_USERNAME__: string;
    __TESTCONTAINERS_RABBITMQ_PASSWORD__: string;
  }
}

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
