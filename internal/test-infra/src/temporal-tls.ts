import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedTemporalTls } from "./containers.js";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __BTRAVSTACK_TEMPORAL_TLS_ADDRESS__: string;
    __BTRAVSTACK_TEMPORAL_API_KEY_ADDRESS__: string;
  }
}

/**
 * The shared Temporal server behind its TLS proxy, beside `./temporal`'s
 * plaintext address: a namespace registered through one is served through the
 * others. One address requires a client certificate, the other an API key.
 */
export default async ({ provide }: TestProject): Promise<void> => {
  const proxy = await sharedTemporalTls();

  provide("__BTRAVSTACK_TEMPORAL_TLS_ADDRESS__", `${proxy.getHost()}:${proxy.getMappedPort(7233)}`);
  provide(
    "__BTRAVSTACK_TEMPORAL_API_KEY_ADDRESS__",
    `${proxy.getHost()}:${proxy.getMappedPort(7234)}`,
  );
};
