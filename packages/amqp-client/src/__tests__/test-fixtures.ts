import { createServer, type AddressInfo, type Socket } from "node:net";

import { TypedAmqpClient, type ConnectionError } from "@amqp-contract/client";
import { Env, type ConfigInvalid, type Environment } from "@btravstack/config";
import {
  HealthChecks,
  Observers,
  type Operation,
  type Settle,
  type Settled,
} from "@btravstack/core";
import { Module, Port, Provider, type Context } from "@btravstack/di";
import { OkAsync, type AsyncResult } from "unthrown";
import { test, vi, type Mock } from "vitest";

import { amqpClient, type AmqpClientOptions, type AnyAmqpContract } from "../index.js";

/** The application's port for the client under test. */
export class Client extends Port("AmqpClientTestClient")<TypedAmqpClient<AnyAmqpContract>> {}

/** A contract with nothing to declare: these specs never publish. */
export const contract = {} as AnyAmqpContract;

/** One operation an observer was handed, with how it settled. */
export type Observation = {
  readonly operation: Operation;
  settled?: Settled;
};

/** A graph around `amqpClient(Client, contract, options)` over `env`, run for the length of `body`. */
export type Scoped = <T, E>(
  options: AmqpClientOptions & { readonly env?: Environment },
  body: (ctx: Context<Client | HealthChecks>) => AsyncResult<T, E>,
) => AsyncResult<T, E | ConfigInvalid | ConnectionError>;

/** A TCP listener on an ephemeral port that hands each connection to `onSocket`. */
const listener = async (onSocket: (socket: Socket) => void) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    onSocket(socket);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `amqp://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((closed) => server.close(closed));
    },
  };
};

/** A stand-in for the upstream client, reached through a spy on `TypedAmqpClient.create`. */
export type Upstream = {
  readonly client: TypedAmqpClient<AnyAmqpContract>;
  readonly create: Mock<typeof TypedAmqpClient.create>;
  readonly close: Mock<() => AsyncResult<void, never>>;
  /** What `client.isConnected()` answers; a spec drops the connection by clearing it. */
  connected: boolean;
};

export const it = test.extend<{
  /** `TypedAmqpClient.create` answering a fake client, with no broker behind it. */
  readonly upstream: Upstream;
  /** A broker that accepts TCP and never speaks AMQP. */
  readonly silentBroker: string;
  /** A broker that drops every connection as it arrives. */
  readonly droppingBroker: string;
  /** Every operation the module reported, in order. */
  readonly observations: Observation[];
  /** An `Observers` member recording into {@link observations}. */
  readonly recorder: (operation: Operation) => Settle;
  readonly scoped: Scoped;
}>({
  // oxlint-disable-next-line no-empty-pattern -- a spy needs no other fixture
  upstream: async ({}, use) => {
    const close = vi.fn(() => OkAsync());
    const upstream: Upstream = {
      client: {
        close,
        isConnected: () => upstream.connected,
      } as unknown as TypedAmqpClient<AnyAmqpContract>,
      create: vi.spyOn(TypedAmqpClient, "create"),
      close,
      connected: true,
    };
    upstream.create.mockReturnValue(OkAsync(upstream.client));
    await use(upstream);
    upstream.create.mockRestore();
  },
  // oxlint-disable-next-line no-empty-pattern -- a TCP listener needs no other fixture
  silentBroker: async ({}, use) => {
    const broker = await listener(() => {});
    await use(broker.url);
    await broker.close();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  droppingBroker: async ({}, use) => {
    const broker = await listener((socket) => socket.destroy());
    await use(broker.url);
    await broker.close();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  observations: async ({}, use) => {
    await use([]);
  },
  recorder: async ({ observations }, use) => {
    await use((operation) => {
      const observation: Observation = { operation };
      observations.push(observation);
      return (settled) => {
        observation.settled = settled;
      };
    });
  },
  scoped: async ({ recorder }, use) => {
    await use(({ env = {}, ...options }, body) =>
      Module.scoped(
        Module("AmqpClientTest")({
          imports: [amqpClient(Client, contract, options)],
          provides: [
            Provider(Env)({ inject: {}, value: env }),
            Provider.member(Observers)({ inject: {}, value: recorder }),
          ],
          exports: [Client, HealthChecks],
        }),
        body,
      ),
    );
  },
});
