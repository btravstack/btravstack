import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("HttpController", () => {
  it("carries the port it minted, under the name it was given", async ({ controllers }) => {
    // GIVEN a controller declared over a fragment of the contract
    const { controller } = controllers;

    // WHEN the provider is inspected
    // THEN it carries a port under the given name, and the deps it declared
    expect({
      portId: controller.port.portId,
      deps: controller.deps.map((dep) => dep.portId),
    }).toEqual({ portId: "HelloController", deps: ["Greeter"] });
  });

  it("keeps the keyed form when a contract names a key `sync`", async () => {
    // GIVEN a contract whose top-level key is literally `sync` — the one input
    // that could confuse `HttpRouter`'s runtime discriminator, which tells its
    // arm-only form from its keyed-controllers form by whether `sync` holds a
    // function
    const { syncKeyedRouter } = await import("./test-fixtures.js");

    // WHEN the router provider is constructed from its controller's service
    const built = await syncKeyedRouter.construct([{ hello: () => OkAsync("hello world") }]);

    // THEN the keyed arm ran: the contract's `sync` key is a mounted procedure,
    // not a factory the arm-only form would have called. A controller is an
    // object carrying `.port`, never a function, which is what makes the check
    // total rather than a heuristic
    expect(built).toBeOkWith(expect.objectContaining({ sync: expect.anything() }));
  });

  it("serves a router composed from several controllers", async ({ rpcSliced }) => {
    // GIVEN an API whose contract is implemented by two separate controllers
    const { client } = await rpcSliced();

    // WHEN one procedure from each controller is called
    const answers = await Promise.all([client.greetings.hello(), client.echoes.ping()]);

    // THEN every controller's slice was mounted under its own contract key
    expect(answers).toEqual(["hello world", "pong"]);
  });
});
