import { createServer, type AddressInfo, type Socket } from "node:net";

import { test } from "vitest";

export const it = test.extend<{ readonly silentBroker: string }>({
  // oxlint-disable-next-line no-empty-pattern -- a TCP listener needs no other fixture
  silentBroker: async ({}, use) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => sockets.add(socket));
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    await use(`amqp://127.0.0.1:${(server.address() as AddressInfo).port}`);
    for (const socket of sockets) socket.destroy();
    await new Promise((closed) => server.close(closed));
  },
});
