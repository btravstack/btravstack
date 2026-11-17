import {
  Config,
  Env,
  type ConfigInvalid,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import {
  HealthCheckFailed,
  HealthChecks,
  Observers,
  noObserverMember,
  observed,
  type Operation,
  type Settle,
} from "@btravstack/core";
import { Module, Port, Provider, type PortClassOf } from "@btravstack/di";
import { TypedClient } from "@temporal-contract/client";
import { Client, type Connection } from "@temporalio/client";
import type { DataConverter } from "@temporalio/common";
import { Err, Ok, OkAsync, fromPromise, fromSafePromise } from "unthrown";
import type { AsyncResult } from "unthrown";

import {
  credentialsOf,
  reloading,
  rotates,
  temporalSecurity,
  type Credentials,
  type TemporalConnectionSecurity,
  type TemporalApiKeySource,
  type TemporalApiKeyUnavailable,
} from "./connection-security.js";
import { connect, type TemporalClientUnreachable } from "./connection.js";

export { TemporalClientUnreachable } from "./connection.js";

export { TemporalApiKeyUnavailable, type TemporalApiKeySource } from "./connection-security.js";

/** What {@link temporalClient} is handed. `address` and `namespace` each pin the variable named beside it. */
export type TemporalClientOptions = {
  /** Pins `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`). */
  readonly address?: string | undefined;
  /** Pins `TEMPORAL_NAMESPACE` (default `default`). */
  readonly namespace?: string | undefined;
  /**
   * The application's port for the `DataConverter` the client encodes and
   * decodes payloads with — the same port the worker's `dataConverter` names.
   * The port joins the module's needs.
   */
  readonly dataConverter?: PortClassOf<string, DataConverter>;
  /**
   * The application's renewable bearer source. Requires TLS and excludes
   * static/file keys and mTLS; a failed refresh closes the connection until a
   * successful reading reconnects. The port joins the module's needs, and
   * `TemporalApiKeyUnavailable` its errors.
   */
  readonly apiKey?: PortClassOf<string, TemporalApiKeySource>;
};

type Settings = {
  readonly address: string;
  readonly namespace: string;
} & TemporalConnectionSecurity;

type Observer = (operation: Operation) => Settle;

const RELOAD: Operation = { component: "temporal-client", name: "reload", attributes: {} };

const WORKFLOW_SERVICE = "temporal.api.workflowservice.v1.WorkflowService";
const SERVING = 1;
const HEALTH_DEADLINE_MS = 800;

/**
 * A `TypedClient` on the application's port, over a connection opened and
 * closed with the scope. Callers bind a contract with `client.for(contract)`.
 *
 * ```ts
 * Module("Scheduling")({ imports: [temporalClient(OrdersClient)], provides: [...] });
 * ```
 *
 * - **Configured from `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`) and
 *   `TEMPORAL_NAMESPACE` (default `default`)**, each pinned by its option, and
 *   the connection's security from Temporal's own variables (`TEMPORAL_TLS`,
 *   `TEMPORAL_TLS_*`, `TEMPORAL_API_KEY`, `TEMPORAL_API_KEY_PATH`,
 *   `TEMPORAL_CREDENTIALS_RELOAD_MS`), which are never pinned. A value or
 *   combination it cannot connect with, or a file it cannot read, is a
 *   `ConfigInvalid` against the client's port.
 * - **A service that does not answer is `TemporalClientUnreachable`**.
 * - **Mounted credential files are read again** every
 *   `TEMPORAL_CREDENTIALS_RELOAD_MS`: a changed API key is set on the open
 *   connection, and changed TLS files open a new one that serves every later
 *   call. A reading that fails is reported to `Observers`
 *   (`component: "temporal-client"`) and retried on the next tick.
 * - **It contributes the `temporal-client:<port id>` health check**, asking the
 *   service's gRPC health endpoint for the workflow service over the current
 *   connection.
 */
export const temporalClient = <
  P extends PortClassOf<string, TypedClient>,
  const O extends TemporalClientOptions = Record<never, never>,
>(
  port: P,
  // `{}` only when the argument is omitted, which is when `O` is `{}` too.
  options: O & OptionsAs<O, TemporalClientOptions> = {} as never,
): Module<
  InstanceType<P> | HealthChecks,
  | ConfigInvalid
  | TemporalClientUnreachable
  | ([Injected<O, "apiKey">] extends [never] ? never : TemporalApiKeyUnavailable),
  | EnvReading<
      never,
      | Unpinned<O, "address", "TEMPORAL_ADDRESS">
      | MaybePinned<O, "address", "TEMPORAL_ADDRESS">
      | Unpinned<O, "namespace", "TEMPORAL_NAMESPACE">
      | MaybePinned<O, "namespace", "TEMPORAL_NAMESPACE">
      | "TEMPORAL_TLS"
      | "TEMPORAL_TLS_SERVER_CA_CERT_PATH"
      | "TEMPORAL_TLS_SERVER_NAME"
      | "TEMPORAL_TLS_CLIENT_CERT_PATH"
      | "TEMPORAL_TLS_CLIENT_KEY_PATH"
      | "TEMPORAL_API_KEY"
      | "TEMPORAL_API_KEY_PATH"
      | "TEMPORAL_CREDENTIALS_RELOAD_MS"
    >
  | Injected<O, "dataConverter">
  | Injected<O, "apiKey">
> => {
  const { settings: settingsPort, connection: connectionPort } = privatePortsFor(port.portId);
  const { dataConverter, apiKey } = options as TemporalClientOptions;
  const schema = Config.object({
    address: Config.pinned(
      options.address,
      Config.string("TEMPORAL_ADDRESS", { default: "127.0.0.1:7233" }),
    ),
    namespace: Config.pinned(
      options.namespace,
      Config.string("TEMPORAL_NAMESPACE", { default: "default" }),
    ),
    ...temporalSecurity,
  });

  // Cast for the needs alone: over generic options the schema's own needs type
  // cannot resolve, so the annotation states the variables.
  return Module("TemporalClient")({
    provides: [
      noObserverMember,
      Provider(settingsPort)({
        inject: { env: Env },
        make: ({ env }): AsyncResult<Settings, ConfigInvalid> =>
          Config.parse(port.portId, schema)(env),
      }),
      Provider(connectionPort)({
        inject: {
          settings: settingsPort,
          observers: Observers,
          ...((apiKey === undefined ? {} : { apiKey }) as {
            apiKey: PortClassOf<string, TemporalApiKeySource>;
          }),
        },
        acquire: ({
          settings,
          observers,
          apiKey: source,
        }: {
          readonly settings: Settings;
          readonly observers: readonly Observer[];
          readonly apiKey?: TemporalApiKeySource;
        }) =>
          credentialsOf(port.portId, settings, source).flatMap((credentials) =>
            connect(settings.address, credentials).map((connection) =>
              rotates(settings, source)
                ? rotating(port.portId, settings, connection, credentials, source, observers)
                : connection,
            ),
          ),
        release: (connection) =>
          physicalOf(connection) === connection ? drained(connection) : connection.close(),
      }),
      Provider(port as PortClassOf<string, TypedClient>)({
        inject: {
          connection: connectionPort,
          settings: settingsPort,
          ...((dataConverter === undefined ? {} : { dataConverter }) as {
            dataConverter: PortClassOf<string, DataConverter>;
          }),
        },
        make: ({
          connection,
          settings: { namespace },
          dataConverter: converter,
        }: {
          readonly connection: Connection;
          readonly settings: Settings;
          readonly dataConverter?: DataConverter;
        }) =>
          TypedClient.create({
            client: new Client({
              connection,
              namespace,
              ...(converter === undefined ? {} : { dataConverter: converter }),
            }),
          }) as AsyncResult<TypedClient, never>,
      }),
      Provider.member(HealthChecks)({
        inject: { connection: connectionPort, settings: settingsPort },
        sync: ({ connection, settings }) => ({
          name: `temporal-client:${port.portId}`,
          check: () => serving(connection, settings.address),
        }),
      }),
    ],
    exports: [port, HealthChecks],
  } as never) as never;
};

/** The instance of the port option `K` names, when `O` names one. */
type Injected<O, K extends keyof TemporalClientOptions> = O extends unknown
  ? K extends keyof O
    ? NonNullable<O[K]> extends infer Named extends abstract new () => unknown
      ? InstanceType<Named>
      : never
    : never
  : never;

/**
 * Asks the service's gRPC health endpoint for the workflow service, as
 * Temporal's Go SDK `CheckHealth` does. Read through the provided connection,
 * so after a rotation it asks the current one.
 */
const serving = (connection: Connection, address: string): AsyncResult<void, HealthCheckFailed> => {
  // Temporal's retry interceptor keeps an unanswered call alive; this ends it once the kernel stops waiting.
  const target = physicalOf(connection);
  const call = target.withDeadline(Date.now() + HEALTH_DEADLINE_MS, () =>
    target.healthService.check({ service: WORKFLOW_SERVICE }),
  );
  const pending = probes.get(target) ?? new Set<Promise<unknown>>();
  probes.set(target, pending);
  pending.add(call);
  const settled = (): void => {
    pending.delete(call);
  };
  void call.then(settled, settled);
  return fromPromise(
    call,
    () => new HealthCheckFailed({ reason: `the Temporal service at ${address} did not answer` }),
  ).flatMap(({ status }) =>
    status === SERVING
      ? Ok(undefined)
      : Err(new HealthCheckFailed({ reason: `the Temporal service at ${address} is not serving` })),
  );
};

/** The health calls in flight on each physical connection, which closing it waits for. */
const probes = new WeakMap<Connection, Set<Promise<unknown>>>();

const PHYSICAL = Symbol("physical");

/** The connection a rotating proxy currently forwards to, or the connection itself. */
const physicalOf = (connection: Connection): Connection =>
  (Reflect.get(connection, PHYSICAL) as Connection | undefined) ?? connection;

/** A probe Temporal's retry interceptor still holds would retry on a closed channel, uncaught. */
const drained = (connection: Connection): Promise<void> =>
  Promise.allSettled([...(probes.get(connection) ?? [])]).then(() => connection.close());

type PrivatePorts = {
  readonly settings: PortClassOf<string, Settings>;
  readonly connection: PortClassOf<string, Connection>;
};

const privatePorts = new Map<string, PrivatePorts>();

function privatePortsFor(id: string): PrivatePorts {
  const existing = privatePorts.get(id);
  if (existing !== undefined) return existing;
  class ClientSettings extends Port(`TemporalClientSettings:${id}`)<Settings> {}
  class ClientConnection extends Port(`TemporalClientConnection:${id}`)<Connection> {}
  const ports = { settings: ClientSettings, connection: ClientConnection };
  privatePorts.set(id, ports);
  return ports;
}

/**
 * A `Connection` forwarding to the one opened with the latest credentials.
 * Temporal's client reads `connection.workflowService` per call, so a call
 * made after a rotation goes out on the new connection; `close` stops the
 * reloading and closes the current one.
 */
const rotating = (
  port: string,
  settings: Settings,
  first: Connection,
  credentials: Credentials,
  source: TemporalApiKeySource | undefined,
  observers: readonly Observer[],
): Connection => {
  let current = first;
  let closed = false;
  const stop = reloading(
    port,
    settings,
    credentials,
    (next, change) =>
      change === "tls"
        ? connect(settings.address, next).flatMap((opened) => {
            const previous = current;
            current = opened;
            const previousClosed = closed;
            closed = false;
            return previousClosed ? OkAsync() : fromSafePromise(drained(previous));
          })
        : OkAsync(current.setApiKey(change.apiKey)),
    (failure) => {
      void observed(observers, RELOAD, () => failure.toAsync());
    },
    source,
    () => {
      if (closed) return OkAsync();
      closed = true;
      // Fail closed at once: no new call carries the removed key while probes settle.
      current.setApiKey(() => "");
      return fromSafePromise(drained(current));
    },
  );
  const close = async (): Promise<void> => {
    await stop();
    if (!closed) {
      closed = true;
      await drained(current);
    }
  };
  return new Proxy(first, {
    get: (_target, key) =>
      key === "close" ? close : key === PHYSICAL ? current : Reflect.get(current, key, current),
  });
};
