import { Module, Port, Provider } from "@btravstack/di";
import { TypedClient } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";
import { OkAsync } from "unthrown";
import { afterEach, expect, test, vi } from "vitest";

import { temporalClient, temporalConnection, type TemporalClientSettings } from "./index.js";

class Settings extends Port("TemporalClientTestSettings")<TemporalClientSettings> {}
class ConnectionPort extends Port("TemporalClientTestConnection")<Connection> {}
class ClientPort extends Port("TemporalClientTestClient")<TypedClient> {}

const moduleWith = (settings: TemporalClientSettings) =>
  Module("TemporalClientTest")({
    provides: [
      Provider(Settings)({ inject: {}, value: settings }),
      temporalConnection(ConnectionPort, Settings),
      temporalClient(ClientPort, ConnectionPort, Settings),
    ],
    exports: [ClientPort],
  });

afterEach(() => vi.restoreAllMocks());

test("shares the scoped connection with the typed client and closes it", async () => {
  // GIVEN a connection and typed client that expose the wrapper's handoff
  const close = vi.fn(() => Promise.resolve());
  const connection = { close } as unknown as Connection;
  const connect = vi.spyOn(Connection, "connect").mockResolvedValue(connection);
  const typed = {} as TypedClient;
  const create = vi.spyOn(TypedClient, "create").mockReturnValue(OkAsync(typed));

  // WHEN the application scope opens and closes
  const result = await Module.scoped(
    moduleWith({ address: "temporal:7233", namespace: "orders" }),
    (ctx) => OkAsync(ctx.get(ClientPort)),
  );

  // THEN the same connection and selected namespace were used, then released once
  const native = create.mock.calls[0]?.[0].client;
  expect({
    client: result.getOrNull(),
    connect: connect.mock.calls,
    native,
    isNativeClient: native instanceof Client,
    closes: close.mock.calls.length,
  }).toEqual({
    client: typed,
    connect: [[{ address: "temporal:7233" }]],
    native: expect.objectContaining({
      connection,
      options: expect.objectContaining({ namespace: "orders" }),
    }),
    isNativeClient: true,
    closes: 1,
  });
});

test("qualifies a failed native connection with the attempted address and cause", async () => {
  // GIVEN a Temporal endpoint that refuses the connection
  const cause = new Error("connection refused");
  vi.spyOn(Connection, "connect").mockRejectedValue(cause);

  // WHEN the application scope tries to open
  const result = await Module.scoped(
    moduleWith({ address: "unavailable:7233", namespace: "orders" }),
    () => OkAsync("unreachable"),
  );

  // THEN the modeled error keeps the endpoint and underlying reason
  expect(result).toBeErrWith(
    expect.objectContaining({
      _tag: "TemporalClientUnreachable",
      address: "unavailable:7233",
      cause,
    }),
  );
});
