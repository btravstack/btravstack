import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("an authenticated procedure", () => {
  it("hands the principal to the handler", async ({ rpcAuthed }) => {
    // GIVEN a client presenting a token the authenticator accepts
    const client = rpcAuthed.clientWith("good");

    // WHEN a marked procedure is called
    // THEN the handler saw the principal the authenticator resolved
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });

  it("answers 401 and never runs the handler when the token is rejected", async ({ rpcAuthed }) => {
    // GIVEN a client presenting a token the authenticator rejects
    const client = rpcAuthed.clientWith("bad");

    // WHEN a marked procedure is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the request was refused and the handler was not entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcAuthed.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "UNAUTHORIZED", ran: 0 });
  });

  it("collapses an authenticator's own defect to a 500, not a 401", async ({ rpcAuthed }) => {
    // GIVEN a client presenting the token the authenticator blows up on
    const client = rpcAuthed.clientWith("boom");

    // WHEN a marked procedure is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the bug is reported as a server error and the handler was not entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcAuthed.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "INTERNAL_SERVER_ERROR", ran: 0 });
  });

  it("serves an unmarked procedure with no credentials at all", async ({ rpcAuthed }) => {
    // GIVEN a client presenting nothing
    const client = rpcAuthed.clientWith(undefined);

    // WHEN an unmarked procedure is called
    // THEN it answers
    await expect(client.health.ping()).resolves.toEqual({ ok: true });
  });
});

describe("a router over a marked contract", () => {
  it("appends the authenticator after the dependencies it already declared", ({
    authedRouterDeps,
  }) => {
    // GIVEN the same marked contract composed through both arms of HttpRouter
    // WHEN each provider's declared dependencies are read
    // THEN the authenticator is last in both, so every existing service keeps its index
    expect(authedRouterDeps).toEqual({
      keyed: ["AuthedOrders", "AuthedHealth", "HttpAuthenticator"],
      positional: ["Greeter", "HttpAuthenticator"],
    });
  });

  it("declares no authenticator when the contract marks nothing", ({ controllers }) => {
    // GIVEN a router composed from a controller over an unmarked contract
    // WHEN its declared dependencies are read
    // THEN nothing was appended — an application with no protected route provides nothing
    expect(controllers.unmarkedRouterDeps).toEqual(["HelloController", "EchoesController"]);
  });
});
