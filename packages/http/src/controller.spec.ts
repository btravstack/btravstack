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

  it("reaches a piece minted below a nested mark, with the principal the ancestor typed", async ({
    rpcNestedMarked,
  }) => {
    // GIVEN a contract marked one level below the root, on "v1" — not the
    // root itself and not a top-level key — with a piece minted at
    // "v1.orders" beneath it
    const client = rpcNestedMarked.clientWith("good");

    // WHEN an authenticated caller invokes the procedure
    // THEN the compile-time fold (`FragmentAt`) and the runtime walk
    // (`routerOf`'s `inherited`) agree: the handler read the principal the
    // ancestor's mark typed
    await expect(client.v1.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });

  it("refuses an unauthenticated caller reaching a piece below a nested mark", async ({
    rpcNestedMarked,
  }) => {
    // GIVEN the same nested-marked contract, with no credentials presented
    const client = rpcNestedMarked.clientWith(undefined);

    // WHEN the caller invokes the procedure
    const call = client.v1.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN it is refused before the handler runs — the fold and the walk
    // agree in the refusal direction too, not only the accepted one
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcNestedMarked.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "UNAUTHORIZED", ran: 0 });
  });
});
