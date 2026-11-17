/**
 * The variables `amqpClient()` reads are in its type: unpinned, both are
 * optional at the boot site, since each has a default; pinned, neither is
 * read. A misspelt option is refused at its own key rather than silently
 * ignored.
 *
 * Type-checked by this package's `typecheck` script, never executed.
 */
import type { ConnectionError, TypedAmqpClient } from "@amqp-contract/client";
import type { ConfigInvalid, EnvReading } from "@btravstack/config";
import type { HealthChecks } from "@btravstack/core";
import { Port, type Module } from "@btravstack/di";
import { expectTypeOf } from "vitest";

import { amqpClient, type AnyAmqpContract } from "./index.js";

declare const contract: AnyAmqpContract;
class Client extends Port("Client")<TypedAmqpClient<AnyAmqpContract>> {}

expectTypeOf(amqpClient(Client, contract)).toEqualTypeOf<
  Module<
    Client | HealthChecks,
    ConfigInvalid | ConnectionError,
    EnvReading<never, "AMQP_URL" | "AMQP_CONNECT_TIMEOUT_MS">
  >
>();

expectTypeOf(
  amqpClient(Client, contract, { url: "amqp://broker", connectTimeoutMs: 750 }),
).toEqualTypeOf<
  Module<Client | HealthChecks, ConfigInvalid | ConnectionError, EnvReading<never, never>>
>();

expectTypeOf(amqpClient(Client, contract, { url: "amqp://broker" })).toEqualTypeOf<
  Module<
    Client | HealthChecks,
    ConfigInvalid | ConnectionError,
    EnvReading<never, "AMQP_CONNECT_TIMEOUT_MS">
  >
>();

declare const maybe: string | undefined;
expectTypeOf(amqpClient(Client, contract, { url: maybe, connectTimeoutMs: 750 })).toEqualTypeOf<
  Module<Client | HealthChecks, ConfigInvalid | ConnectionError, EnvReading<never, "AMQP_URL">>
>();

// @ts-expect-error — `urls` is not an option; the broker is `url`.
amqpClient(Client, contract, { urls: ["amqp://broker"] });
