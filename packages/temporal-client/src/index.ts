import { Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { TypedClient } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";
import type { DataConverter } from "@temporalio/common";
import { TaggedError, fromPromise } from "unthrown";
import type { AsyncResult } from "unthrown";

/** The deployment settings needed to call a Temporal service. */
export type TemporalClientSettings = {
  readonly address: string;
  readonly namespace: string;
};

/** The Temporal service did not answer while the client connection opened. */
export class TemporalClientUnreachable extends TaggedError("TemporalClientUnreachable")<{
  readonly address: string;
  readonly cause: unknown;
}> {
  override message = `the Temporal service at ${this.address} did not answer`;
}

/** Acquire and release a Temporal connection with the DI scope. */
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
    acquire: ({ settings: { address } }) =>
      fromPromise(
        Connection.connect({ address }),
        (cause) => new TemporalClientUnreachable({ address, cause }),
      ) as AsyncResult<ServiceOf<typeof port>, TemporalClientUnreachable>,
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
