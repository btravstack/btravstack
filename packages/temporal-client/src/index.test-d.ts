/**
 * The variables `temporalClient()` reads are in its type: unpinned, the address
 * and namespace may be set (both default); pinned, neither is read. The
 * security variables are never pinned. An option port joins the needs, and an
 * `apiKey` source its error.
 *
 * Type-checked by this package's `typecheck` script, never executed.
 */
import type { ConfigInvalid, EnvReading } from "@btravstack/config";
import type { HealthChecks } from "@btravstack/core";
import { Port, type Module } from "@btravstack/di";
import type { TypedClient } from "@temporal-contract/client";
import type { DataConverter } from "@temporalio/common";
import { expectTypeOf } from "vitest";

import {
  temporalClient,
  type TemporalApiKeySource,
  type TemporalApiKeyUnavailable,
  type TemporalClientUnreachable,
} from "./index.js";

class Orders extends Port("TypeOrdersClient")<TypedClient> {}
class Converter extends Port("TypeConverter")<DataConverter> {}
class ApiKey extends Port("TypeApiKey")<TemporalApiKeySource> {}

type Security =
  | "TEMPORAL_TLS"
  | "TEMPORAL_TLS_SERVER_CA_CERT_PATH"
  | "TEMPORAL_TLS_SERVER_NAME"
  | "TEMPORAL_TLS_CLIENT_CERT_PATH"
  | "TEMPORAL_TLS_CLIENT_KEY_PATH"
  | "TEMPORAL_API_KEY"
  | "TEMPORAL_API_KEY_PATH"
  | "TEMPORAL_CREDENTIALS_RELOAD_MS";

expectTypeOf(temporalClient(Orders)).toEqualTypeOf<
  Module<
    Orders | HealthChecks,
    ConfigInvalid | TemporalClientUnreachable,
    EnvReading<never, "TEMPORAL_ADDRESS" | "TEMPORAL_NAMESPACE" | Security>
  >
>();

expectTypeOf(
  temporalClient(Orders, { address: "temporal:7233", namespace: "orders" }),
).toEqualTypeOf<
  Module<
    Orders | HealthChecks,
    ConfigInvalid | TemporalClientUnreachable,
    EnvReading<never, Security>
  >
>();

declare const maybe: string | undefined;
expectTypeOf(temporalClient(Orders, { address: maybe, namespace: "orders" })).toEqualTypeOf<
  Module<
    Orders | HealthChecks,
    ConfigInvalid | TemporalClientUnreachable,
    EnvReading<never, "TEMPORAL_ADDRESS" | Security>
  >
>();

expectTypeOf(temporalClient(Orders, { dataConverter: Converter })).toEqualTypeOf<
  Module<
    Orders | HealthChecks,
    ConfigInvalid | TemporalClientUnreachable,
    EnvReading<never, "TEMPORAL_ADDRESS" | "TEMPORAL_NAMESPACE" | Security> | Converter
  >
>();

expectTypeOf(temporalClient(Orders, { apiKey: ApiKey })).toEqualTypeOf<
  Module<
    Orders | HealthChecks,
    ConfigInvalid | TemporalClientUnreachable | TemporalApiKeyUnavailable,
    EnvReading<never, "TEMPORAL_ADDRESS" | "TEMPORAL_NAMESPACE" | Security> | ApiKey
  >
>();

// @ts-expect-error — `taskQueue` is the worker's option, not the client's.
temporalClient(Orders, { taskQueue: "orders" });
