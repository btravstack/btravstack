import type { ConfigInvalid } from "@btravstack/config";
import { Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { TypedClient } from "@temporal-contract/client";
import { Client, type Connection } from "@temporalio/client";
import type { DataConverter } from "@temporalio/common";
import { OkAsync, fromSafePromise } from "unthrown";
import type { AsyncResult } from "unthrown";

import {
  credentialsOf,
  reloading,
  rotates,
  type Credentials,
  type TemporalConnectionSecurity,
  type TemporalApiKeySource,
  type TemporalApiKeyUnavailable,
} from "./connection-security.js";
import { connect, type TemporalClientUnreachable } from "./connection.js";

export { TemporalClientUnreachable } from "./connection.js";

export {
  temporalSecurity,
  TemporalApiKeyUnavailable,
  type TemporalApiKeySource,
  type TemporalConnectionSecurity,
} from "./connection-security.js";

/**
 * The deployment settings needed to call a Temporal service: where it is, the
 * namespace, and optionally how the connection is secured.
 */
export type TemporalClientSettings = {
  readonly address: string;
  readonly namespace: string;
} & TemporalConnectionSecurity;

/**
 * Acquire and release a Temporal connection with the DI scope, secured as the
 * settings say. A combination the settings cannot connect with, or a file
 * they name that cannot be read, is a `ConfigInvalid` against the settings
 * port. When the settings name a certificate, CA or API key file, the files
 * are read again every `credentialsReloadMs`: a changed API key is set on the
 * open connection, and changed TLS files open a new connection that serves
 * every later call, the previous one closing once its calls finish.
 * `options.apiKey` names an application-owned `TemporalApiKeySource` port. It
 * requires TLS and excludes static/file keys and mTLS; a failed refresh closes
 * the connection until a successful source reading reconnects.
 */
export const temporalConnection = <
  Settings extends TemporalClientSettings,
  const ConnectionId extends string,
  const SettingsId extends string,
  ApiKey extends PortClassOf<string, TemporalApiKeySource> = never,
>(
  port: PortClassOf<ConnectionId, Connection>,
  settings: PortClassOf<SettingsId, Settings>,
  options?: { readonly apiKey: ApiKey },
) =>
  Provider(port)({
    inject: {
      settings,
      ...((options === undefined ? {} : { apiKey: options.apiKey }) as { apiKey: ApiKey }),
    },
    acquire: ({ settings: bound, apiKey: source }) =>
      credentialsOf(settings.portId, bound, source).flatMap((credentials) =>
        connect(bound.address, credentials).map((connection) =>
          rotates(bound, source)
            ? rotating(settings.portId, bound, connection, credentials, source)
            : connection,
        ),
      ) as AsyncResult<
        ServiceOf<typeof port>,
        | TemporalClientUnreachable
        | ConfigInvalid
        | ([ApiKey] extends [never] ? never : TemporalApiKeyUnavailable)
      >,
    release: (connection) => connection.close(),
  });

/**
 * Bind the typed Temporal client; callers choose a contract with `client.for(contract)`.
 * `dataConverter`, when given, is the application's port for the `DataConverter`
 * the client encodes and decodes payloads with — the same port the worker resolves.
 */
export const temporalClient = <
  Settings extends TemporalClientSettings,
  const ClientId extends string,
  const ConnectionId extends string,
  const SettingsId extends string,
  Converter extends PortClassOf<string, DataConverter> = never,
>(
  port: PortClassOf<ClientId, TypedClient>,
  connection: PortClassOf<ConnectionId, Connection>,
  settings: PortClassOf<SettingsId, Settings>,
  dataConverter?: Converter,
) =>
  Provider(port)({
    inject: {
      connection,
      settings,
      ...((dataConverter === undefined ? {} : { dataConverter }) as { dataConverter: Converter }),
    },
    make: ({ connection, settings: { namespace }, dataConverter: converter }) =>
      TypedClient.create({
        client: new Client({
          connection,
          namespace,
          ...(converter === undefined ? {} : { dataConverter: converter }),
        }),
      }) as AsyncResult<ServiceOf<typeof port>, never>,
  });

/**
 * A `Connection` forwarding to the one opened with the latest credentials.
 * Temporal's client reads `connection.workflowService` per call, so a call
 * made after a rotation goes out on the new connection; `close` stops the
 * reloading and closes the current one.
 */
const rotating = (
  port: string,
  settings: TemporalClientSettings,
  first: Connection,
  credentials: Credentials,
  source: TemporalApiKeySource | undefined,
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
            return previousClosed ? OkAsync() : fromSafePromise(previous.close());
          })
        : OkAsync(current.setApiKey(change.apiKey)),
    undefined,
    source,
    () => {
      if (closed) return OkAsync();
      closed = true;
      return fromSafePromise(current.close());
    },
  );
  const close = async (): Promise<void> => {
    await stop();
    if (!closed) {
      closed = true;
      await current.close();
    }
  };
  return new Proxy(first, {
    get: (_target, key) => (key === "close" ? close : Reflect.get(current, key, current)),
  });
};
