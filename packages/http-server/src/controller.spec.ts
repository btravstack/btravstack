import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("OrpcController", () => {
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
    }).toEqual({ portId: "OrpcController:greetings", deps: ["Greeter"] });
  });

  it("hands a no-deps router's sync one empty services record", async ({ noDepsRouter }) => {
    // GIVEN a router declaring `inject: {}`, whose `sync` records its arguments
    const { provider, handed } = noDepsRouter;

    // WHEN the graph constructs it
    await provider.construct([]);

    // THEN it was handed exactly one argument, the empty record `inject` names —
    // invisible to an arrow, visible to a rest parameter
    expect(handed()).toEqual([{}]);
  });

  it("serves a router composed from one piece per contract key", async ({ rpcSliced }) => {
    // GIVEN an API whose contract is implemented by two separate pieces
    const { client } = await rpcSliced();

    // WHEN one procedure from each piece is called
    const answers = await Promise.all([client.greetings.hello(), client.echoes.ping()]);

    // THEN every piece's slice was mounted under the contract key its port id carries
    expect(answers).toEqual(["hello world", "pong"]);
  });

  it("serves two pieces minted under one shared nested parent path", async ({ rpcDeep }) => {
    // GIVEN a contract split by "v1.orders" and "v1.customers" — pieces that
    // share the "v1" node, so `nest`'s `node[segment] ??= {}` must find the
    // node the first piece already created rather than only ever creating one
    const { client } = await rpcDeep();

    // WHEN one procedure from each piece is called
    const answers = await Promise.all([client.v1.orders.place(), client.v1.customers.find()]);

    // THEN both pieces answered through the one "v1" node `nest` rebuilt once
    expect(answers).toEqual([{ id: "o-1" }, { id: "c-1" }]);
  });

  it("serves a piece minted at a bare procedure path", async ({ rpcDeep }) => {
    // GIVEN a piece minted at "health" — a procedure, not a fragment: the
    // depth-N leaf case, where the path names no node to nest anything under
    const { client } = await rpcDeep();

    // WHEN its procedure is called
    // THEN it answers exactly like a fragment-rooted piece
    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  it("nests a dotted path without writing through a prototype", async ({ rpcDeep }) => {
    // GIVEN a router composed from dotted paths, which `nest` rebuilt into the
    // nesting the contract has — on a plain `{}`, a `"__proto__"` segment reads
    // `Object.prototype` rather than a missing key, and the walk writes the
    // piece onto it
    await rpcDeep();

    // WHEN a bare object is asked for the keys those paths are built from
    // THEN it carries none of them: the rebuild reached no prototype
    expect(
      Object.getOwnPropertyNames(Object.prototype).filter((key) =>
        ["v1", "orders", "customers", "health", "polluted"].includes(key),
      ),
    ).toEqual([]);
  });
});
