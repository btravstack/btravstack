import { TypedAmqpClient, type ConnectionError } from "@amqp-contract/client";
import { Provider, type PortClassOf, type ServiceOf } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

/** A contract accepted by the underlying typed AMQP client. */
export type AnyAmqpContract = Parameters<typeof TypedAmqpClient.create>[0]["contract"];

/** The deployment settings needed to open a publisher connection. */
export type AmqpClientSettings = {
  readonly url: string;
  readonly connectTimeoutMs?: number;
};

/** Bind a typed AMQP client to an application port for the lifetime of the DI scope. */
export const amqpClient = <
  C extends AnyAmqpContract,
  Settings extends AmqpClientSettings,
  const ClientId extends string,
  const SettingsId extends string,
>(
  port: PortClassOf<ClientId, TypedAmqpClient<C>>,
  contract: C,
  settings: PortClassOf<SettingsId, Settings>,
) =>
  Provider(port)({
    inject: { settings },
    acquire: ({ settings: { url, connectTimeoutMs } }) =>
      TypedAmqpClient.create({
        contract,
        urls: [url],
        connectTimeoutMs: connectTimeoutMs ?? 5_000,
      }) as AsyncResult<ServiceOf<typeof port>, ConnectionError>,
    release: (client) => client.close().get(),
  });
