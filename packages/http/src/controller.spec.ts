import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("HttpController", () => {
  it("carries the port its contract key minted, and the deps it declared", async ({
    controllers,
  }) => {
    // GIVEN a piece minted from the contract and one of its keys
    const { controller } = controllers;

    // WHEN the provider is inspected
    // THEN its port id carries the contract key behind the prefix, next to the
    // deps it declared
    expect({
      portId: controller.port.portId,
      deps: controller.deps.map((dep) => dep.portId),
    }).toEqual({ portId: "HttpController:greetings", deps: ["Greeter"] });
  });

  it("hands an arm-only router's sync no arguments", async () => {
    // GIVEN an arm-only router whose `sync` records how many arguments it got.
    // Its declared type is `() => Implementation`, and the whole point of the
    // no-deps arm is that the runtime honours that
    const { armOnlyRouterRecording } = await import("./test-fixtures.js");
    const { provider, arity } = armOnlyRouterRecording();

    // WHEN the graph constructs it
    await provider.construct([]);

    // THEN it was called with none — a record would be ignored by an arrow but
    // seen by a rest parameter, and it would contradict the arity `Provider`
    // guarantees a no-deps factory
    expect(arity()).toBe(0);
  });

  it("serves a router composed from one piece per contract key", async ({ rpcSliced }) => {
    // GIVEN an API whose contract is implemented by two separate pieces
    const { client } = await rpcSliced();

    // WHEN one procedure from each piece is called
    const answers = await Promise.all([client.greetings.hello(), client.echoes.ping()]);

    // THEN every piece's slice was mounted under the contract key its port id carries
    expect(answers).toEqual(["hello world", "pong"]);
  });
});
