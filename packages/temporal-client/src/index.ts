import { Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import { TypedClient } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";
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

/** Bind the typed Temporal client; callers choose a contract with `client.for(contract)`. */
export const temporalClient = <
  Settings extends TemporalClientSettings,
  const ClientId extends string,
  const ConnectionId extends string,
  const SettingsId extends string,
>(
  port: PortClassOf<ClientId, TypedClient>,
  connection: PortClassOf<ConnectionId, Connection>,
  settings: PortClassOf<SettingsId, Settings>,
) =>
  Provider(port)({
    inject: { connection, settings },
    make: ({ connection, settings: { namespace } }) =>
      TypedClient.create({ client: new Client({ connection, namespace }) }) as AsyncResult<
        ServiceOf<typeof port>,
        never
      >,
  });
