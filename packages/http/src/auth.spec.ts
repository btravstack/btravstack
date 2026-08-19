import { describe, expect } from "vitest";

import { Unauthenticated, noAuthenticator } from "./auth.js";
import { it } from "./test-fixtures.js";

describe("an authenticated procedure", () => {
  it("hands the principal to the handler", async ({ rpcAuthed }) => {
    // GIVEN a client presenting a token the authenticator accepts
    const client = rpcAuthed.clientWith("good");

    // WHEN a marked procedure is called
    // THEN the handler saw the principal the authenticator resolved
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });

  it("answers 401 without the authenticator's reason, and never runs the handler", async ({
    rpcAuthed,
  }) => {
    // GIVEN a client presenting a token the authenticator rejects with a reason
    const client = rpcAuthed.clientWith("bad");

    // WHEN a marked procedure is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the request was refused, the reason stayed in the process, and the
    // handler was not entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        message: (error as { message: string }).message,
        ran: rpcAuthed.handlerRuns(),
      })),
    ).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: expect.not.stringContaining("not the good token"),
      ran: 0,
    });
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

describe("a contract marked at its root", () => {
  it("protects every leaf beneath it", async ({ rpcRootMarked }) => {
    // GIVEN a client presenting a token the authenticator rejects
    const client = rpcRootMarked.clientWith("bad");

    // WHEN the only procedure — marked by the root alone — is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the authenticator ran, refused, and the handler was never entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcRootMarked.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "UNAUTHORIZED", ran: 0 });
  });

  it("hands the principal to a leaf the root alone marked", async ({ rpcRootMarked }) => {
    // GIVEN a client presenting a token the authenticator accepts
    const client = rpcRootMarked.clientWith("good");

    // WHEN the only procedure is called
    // THEN the principal the authenticator resolved reached the handler
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
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

describe("the fail-closed authenticator", () => {
  it("refuses every caller, so a mark with nothing behind it is a 401", async () => {
    // GIVEN the stand-in a marked leaf gets when no authenticator reached the walk
    // WHEN it is asked to name a caller
    // THEN it refuses — the safe direction for a disagreement between the two halves
    await expect(noAuthenticator({})).resolves.toBeErrWith(
      expect.objectContaining({ reason: "no authenticator", constructor: Unauthenticated }),
    );
  });
});

describe("a controller minted by httpAuth", () => {
  it("sees the identity the authenticator resolved, not the contract's principal", async ({
    rpcIdentity,
  }) => {
    // GIVEN a client the deployment's authenticator accepts
    const client = rpcIdentity.clientWith("good");

    // WHEN a marked procedure reads a field the contract declares nowhere
    // THEN the handler read it off the very object the authenticator resolved
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });
});
