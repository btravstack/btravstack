import type {} from "vitest";

/**
 * Everything the setup modules in this workspace `provide`, as one type-only
 * entry point (`@btravstack/internal-test-infra/vitest`) a consuming
 * workspace pulls in from its own `src/vitest.d.ts`.
 *
 * It is declared here rather than imported from the upstream packages that
 * also declare these keys: `@amqp-contract/testing` and
 * `@temporal-contract/testing` augment vitest from their own global-setup
 * entry points, and a type-only import of those does not carry the
 * augmentation across pnpm's peer-linked copies of vitest. The `import type
 * {} from "vitest"` above is load-bearing for the same reason a module
 * augmentation always needs one — TypeScript can only augment a module the
 * program has actually loaded.
 */
declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_RABBITMQ_IP__: string;
    __TESTCONTAINERS_RABBITMQ_PORT_5672__: number;
    __TESTCONTAINERS_RABBITMQ_PORT_15672__: number;
    __TESTCONTAINERS_RABBITMQ_USERNAME__: string;
    __TESTCONTAINERS_RABBITMQ_PASSWORD__: string;
    __TESTCONTAINERS_TEMPORAL_IP__: string;
    __TESTCONTAINERS_TEMPORAL_PORT_7233__: number;
  }
}
