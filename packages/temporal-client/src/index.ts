import type { ConfigInvalid } from "@btravstack/config";
import { Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { TypedClient } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";
import type { DataConverter } from "@temporalio/common";
import { OkAsync, TaggedError, fromPromise, fromSafePromise } from "unthrown";
import type { AsyncResult } from "unthrown";

import {
  connectionOptions,
  credentialsOf,
  reloading,
  rotates,
  type Credentials,
  type TemporalConnectionSecurity,
} from "./connection-security.js";

export { temporalSecurity, type TemporalConnectionSecurity } from "./connection-security.js";

/**
 * The deployment settings needed to call a Temporal service: where it is, the
 * namespace, and optionally how the connection is secured.
 */
export type TemporalClientSettings = {
  readonly address: string;
  readonly namespace: string;
} & TemporalConnectionSecurity;

/** The Temporal service did not answer while the client connection opened. */
export class TemporalClientUnreachable extends TaggedError("TemporalClientUnreachable")<{
  readonly address: string;
  readonly cause: unknown;
}> {
  override message = `the Temporal service at ${this.address} did not answer`;
}

/**
 * Acquire and release a Temporal connection with the DI scope, secured as the
 * settings say. A combination the settings cannot connect with, or a file
 * they name that cannot be read, is a `ConfigInvalid` against the settings
 * port. When the settings name a certificate, CA or API key file, the files
 * are read again every `credentialsReloadMs`: a changed API key is set on the
 * open connection, and changed TLS files open a new connection that serves
 * every later call, the previous one closing once its calls finish.
 */
export const temporalConnection = <
  Settings extends TemporalClientSettings,
  const ConnectionId extends string,
  const SettingsId extends string,
>(
  port: PortClassOf<ConnectionId, Connection>,
  settings: PortClassOf<SettingsId, Settings>,
) =>
  Provider(port)({
    inject: { settings },
    acquire: ({ settings: bound }) =>
      credentialsOf(settings.portId, bound).flatMap((credentials) =>
        connect(bound.address, credentials).map((connection) =>
          rotates(bound) ? rotating(settings.portId, bound, connection, credentials) : connection,
        ),
      ) as AsyncResult<ServiceOf<typeof port>, TemporalClientUnreachable | ConfigInvalid>,
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

const connect = (
  address: string,
  credentials: Credentials,
): AsyncResult<Connection, TemporalClientUnreachable> =>
  fromPromise(
    Connection.connect({ address, ...connectionOptions(credentials) }),
    (cause) => new TemporalClientUnreachable({ address, cause }),
  );

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
): Connection => {
  let current = first;
  const stop = reloading(port, settings, credentials, (next, change) =>
    change === "tls"
      ? connect(settings.address, next).flatMap((opened) => {
          const previous = current;
          current = opened;
          return fromSafePromise(previous.close());
        })
      : OkAsync(current.setApiKey(change.apiKey)),
  );
  const close = (): Promise<void> => {
    stop();
    return current.close();
  };
  return new Proxy(first, {
    get: (_target, key) => (key === "close" ? close : Reflect.get(current, key, current)),
  });
};
