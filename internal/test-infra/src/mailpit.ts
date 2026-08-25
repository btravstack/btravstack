import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { sharedMailpit } from "./containers.js";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __TESTCONTAINERS_SMTP_URL__: string;
    __TESTCONTAINERS_MAILPIT_API__: string;
  }
}

/**
 * Two addresses, because a mail suite needs both halves: the SMTP endpoint
 * `smtpMailer()` reads out of the environment, and the HTTP API a spec reads
 * the delivered message back through.
 */
export default async ({ provide }: TestProject): Promise<() => void> => {
  const mailpit = await sharedMailpit();
  const host = mailpit.getHost();

  provide("__TESTCONTAINERS_SMTP_URL__", `smtp://${host}:${mailpit.getMappedPort(1025)}`);
  provide("__TESTCONTAINERS_MAILPIT_API__", `http://${host}:${mailpit.getMappedPort(8025)}`);

  // Nothing to tear down: the container is reused, so stopping it here would
  // pull it out from under whichever workspace's run is still going.
  return () => {};
};
