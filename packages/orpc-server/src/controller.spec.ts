import { Module } from "@btravstack/di";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type RouterContractClient } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { OkAsync } from "unthrown";
import { describe, expect, vi } from "vitest";
import { z } from "zod";

import { it } from "./__tests__/test-fixtures.js";
import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";

describe("OrpcController", () => {
  it("resolves a shared resource name independently for separate API namespaces", async ({
    portWarnings,
  }) => {
    // GIVEN two APIs whose contracts both declare payments
    const firstContract = { payments: { sync: oc } };
    const secondContract = { payments: { sync: oc } };
    const firstImplementation = { sync: () => OkAsync("first") };
    const secondImplementation = { sync: () => OkAsync("second") };
    const first = defineHttp({ namespace: "first" }).OrpcController(
      firstContract,
      "payments",
    )({
      sync: () => firstImplementation,
    });
    const second = defineHttp({ namespace: "second" }).OrpcController(
      secondContract,
      "payments",
    )({
      sync: () => secondImplementation,
    });

    // WHEN both controllers are resolved in one process and graph
    const resolved = await Module.build(
      Module("SeparateContracts")({
        provides: [first, second],
        exports: [first, second],
      }),
    ).map((ctx) => [
      ctx.get(first.port) === firstImplementation,
      ctx.get(second.port) === secondImplementation,
    ]);

    // THEN neither port shadows the other or emits a duplicate-id warning
    expect({ resolved, warnings: portWarnings() }).toEqual({
      resolved: expect.toBeOkWith([true, true]),
      warnings: [],
    });
  });

  it("reuses the port for the same namespace and path across API bindings", ({ portWarnings }) => {
    // GIVEN one contract shared by two API bindings
    const contract = { payments: { sync: oc } };
    const first = defineHttp().OrpcController(
      contract,
      "payments",
    )({
      sync: () => ({ sync: () => OkAsync("first") }),
    });

    // WHEN another API mints the same contract path
    const second = defineHttp().OrpcController(
      contract,
      "payments",
    )({
      sync: () => ({ sync: () => OkAsync("second") }),
    });

    // THEN it uses the existing port without redeclaring its identifier
    expect({ samePort: first.port === second.port, warnings: portWarnings() }).toEqual({
      samePort: true,
      warnings: [],
    });
  });

  it("keeps named API identities separate from colon-containing unnamed keys", () => {
    // GIVEN an unnamed resource and a named API with similar spelling
    const unnamed = defineHttp();
    const named = defineHttp({ namespace: "first" });
    const unnamedContract = { "first:payments": { sync: oc } };
    const namedContract = { payments: { sync: oc } };

    // WHEN their controller ports are minted
    const first = unnamed.OrpcController(
      unnamedContract,
      "first:payments",
    )({
      sync: () => ({ sync: () => OkAsync("unnamed") }),
    });
    const second = named.OrpcController(
      namedContract,
      "payments",
    )({
      sync: () => ({ sync: () => OkAsync("named") }),
    });

    // THEN their identifiers cannot alias through a namespace separator
    expect([first.port.portId, second.port.portId]).toEqual([
      "OrpcController:first:payments",
      "OrpcController[first]:payments",
    ]);
  });

  it("still refuses two providers for the same contract path", async () => {
    // GIVEN two implementations claiming the same contract path
    const contract = { payments: { sync: oc } };
    const api = defineHttp();
    const first = api.OrpcController(
      contract,
      "payments",
    )({
      sync: () => ({ sync: () => OkAsync("first") }),
    });
    const second = api.OrpcController(
      contract,
      "payments",
    )({
      sync: () => ({ sync: () => OkAsync("second") }),
    });

    // WHEN a graph provides both
    const built = await Module.build(Module("DuplicateControllers")({ provides: [first, second] }));

    // THEN duplicate ownership remains a wiring defect
    expect(built).toBeDefectWith(
      expect.objectContaining({ message: expect.stringContaining("two providers") }),
    );
  });

  it("refuses duplicate recovered paths from separate contract objects", async () => {
    // GIVEN compatible contracts each contributing a payments controller
    const firstContract = { payments: { sync: oc } };
    const secondContract = { payments: { sync: oc } };
    const api = defineHttp();
    const implementation = { sync: () => OkAsync("payment") };
    const first = api.OrpcController(firstContract, "payments")({ sync: () => implementation });
    const second = api.OrpcController(secondContract, "payments")({ sync: () => implementation });
    const router = api.OrpcRouter(firstContract)([first, second]);

    // WHEN the router constructs from both implementations
    const built = await router.construct([implementation, implementation, {}]);

    // THEN no controller silently replaces the other
    expect(built).toBeDefectWith(
      expect.objectContaining({ message: expect.stringContaining("duplicate controller path") }),
    );
  });

  it("reuses controller identity across separately loaded module copies", async () => {
    // GIVEN a controller minted by the already loaded factory
    const contract = { payments: { sync: oc } };
    const first = defineHttp().OrpcController(
      contract,
      "payments",
    )({
      sync: () => ({ sync: () => OkAsync("first") }),
    });

    // WHEN another module instance mints the same contract path
    vi.resetModules();
    const { controllerFor } = await import("./controller.js");
    const second = controllerFor<never>("")(contract, "payments")({
      sync: () => ({ sync: () => OkAsync("second") }),
    });

    // THEN both module copies target the same port
    expect(second.port).toBe(first.port);
  });

  it("keeps namespaces out of RPC resource keys and OpenAPI paths", async ({ boot }) => {
    // GIVEN separate contracts sharing a resource key that itself contains a colon
    const firstContract = {
      "payments:internal": {
        sync: oc.meta(openapi({ method: "GET", path: "/payments/sync" })).output(z.string()),
      },
    };
    const secondContract = { ...firstContract };
    const firstApi = defineHttp({ namespace: "wire-first" });
    const secondApi = defineHttp({ namespace: "wire-second" });
    const first = firstApi.OrpcController(
      firstContract,
      "payments:internal",
    )({
      sync: () => ({ sync: () => OkAsync("first") }),
    });
    const second = secondApi.OrpcController(
      secondContract,
      "payments:internal",
    )({
      sync: () => ({ sync: () => OkAsync("second") }),
    });
    const firstInfo = (
      await boot(
        HttpModule("FirstPayments")({
          router: firstApi.OrpcRouter(firstContract)([first]),
          port: 0,
          hostname: "127.0.0.1",
          openapi: true,
        }),
      ).runtimeInfo()
    ).get();
    const secondInfo = (
      await boot(
        HttpModule("SecondPayments")({
          router: secondApi.OrpcRouter(secondContract)([second]),
          port: 0,
          hostname: "127.0.0.1",
          openapi: true,
        }),
      ).runtimeInfo()
    ).get();
    // WHEN each deployment is called at its ordinary wire path
    const client: RouterContractClient<typeof firstContract> = createORPCClient(
      new RPCLink({
        origin: `http://127.0.0.1:${firstInfo?.port}`,
        url: "/rpc",
      }),
    );
    const rpc = await client["payments:internal"].sync();
    const openApi = await fetch(`http://127.0.0.1:${secondInfo?.port}/api/payments/sync`);

    // THEN each answers its own implementation without a namespace in either URL
    expect({ rpc, openApi: { status: openApi.status, body: await openApi.json() } }).toEqual({
      rpc: "first",
      openApi: { status: 200, body: "second" },
    });
  });

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
    }).toEqual({
      portId: "OrpcController:greetings",
      deps: ["Greeter"],
    });
  });

  it("hands a no-deps router's sync one empty services record", async ({ noDepsRouter }) => {
    // GIVEN a router declaring no `inject`, whose `sync` records its arguments
    const { provider, handed } = noDepsRouter;

    // WHEN the graph constructs it
    await provider.construct([]);

    // THEN it was handed exactly one argument, an empty record —
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
