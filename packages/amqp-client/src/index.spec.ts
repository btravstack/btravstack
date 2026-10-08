import { ConnectionError, TypedAmqpClient } from "@amqp-contract/client";
import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync } from "unthrown";
import { afterEach, expect, test, vi } from "vitest";

import { amqpClient, type AnyAmqpContract, type AmqpClientSettings } from "./index.js";

class Settings extends Port("AmqpClientTestSettings")<AmqpClientSettings> {}
class Client extends Port("AmqpClientTestClient")<TypedAmqpClient<AnyAmqpContract>> {}

const contract = {} as AnyAmqpContract;
const moduleWith = (settings: AmqpClientSettings) =>
  Module("AmqpClientTest")({
    provides: [
      Provider(Settings)({ inject: {}, value: settings }),
      amqpClient(Client, contract, Settings),
    ],
    exports: [Client],
  });

afterEach(() => vi.restoreAllMocks());

test.each([
  [{ url: "amqp://broker" }, 5_000],
  [{ url: "amqp://broker", connectTimeoutMs: 750 }, 750],
] as const)(
  "passes settings to the upstream client and closes it on scope exit",
  async (settings, timeout) => {
    // GIVEN a typed client whose connection and close can be observed without a broker
    const close = vi.fn(() => OkAsync(undefined));
    const client = { close } as unknown as TypedAmqpClient<AnyAmqpContract>;
    const create = vi.spyOn(TypedAmqpClient, "create").mockReturnValue(OkAsync(client));

    // WHEN the application scope opens and closes
    const result = await Module.scoped(moduleWith(settings), (ctx) => OkAsync(ctx.get(Client)));

    // THEN the requested connection settings and one cleanup reached the upstream client
    expect({
      client: result.getOrNull(),
      options: create.mock.calls[0]?.[0],
      closes: close.mock.calls.length,
    }).toEqual({
      client,
      options: { contract, urls: [settings.url], connectTimeoutMs: timeout },
      closes: 1,
    });
  },
);

test("preserves the upstream connection error on the startup channel", async () => {
  // GIVEN an upstream connection refusal
  const error = new ConnectionError("broker unavailable");
  vi.spyOn(TypedAmqpClient, "create").mockReturnValue(ErrAsync(error));

  // WHEN the scope tries to acquire the client
  const result = await Module.scoped(moduleWith({ url: "amqp://unavailable" }), () =>
    OkAsync("unreachable"),
  );

  // THEN the application gets the original modeled error
  expect(result).toBeErrWith(error);
});
