import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("http, over several answerers", () => {
  it("routes a request to the answerer whose prefix matches longest", async ({ mounted }) => {
    // GIVEN a fragment answerer at the root and an RPC one under /rpc
    const { at } = await mounted(["/", "/rpc"]);

    // WHEN a path under each is requested
    const answered = { root: await at("/orders/42"), rpc: await at("/rpc/orders") };

    // THEN the nested mount won its own path and the root took the rest —
    // nesting is the expected shape, not a conflict
    expect({ root: answered.root.body, rpc: answered.rpc.body }).toEqual({
      root: "/",
      rpc: "/rpc",
    });
  });

  it("gives a mount point the path that IS it, not only the ones under it", async ({ mounted }) => {
    // GIVEN an answerer mounted at /graphql
    const { at } = await mounted(["/rpc", "/graphql"]);

    // WHEN the mount point itself is requested
    const response = await at("/graphql");

    // THEN it answered — a GraphQL POST lands on the mount, never under it
    expect(response.body).toBe("/graphql");
  });

  it("answers 404 for a path no answerer is mounted on", async ({ mounted }) => {
    // GIVEN answerers that between them claim only /rpc and /graphql
    const { at } = await mounted(["/rpc", "/graphql"]);

    // WHEN a path outside both is requested
    const response = await at("/orders/42");

    // THEN the runtime's own 404, with no answerer consulted
    expect(response.status).toBe(404);
  });

  it("does not let a mount point swallow a path that merely starts with it", async ({
    mounted,
  }) => {
    // GIVEN an answerer at /rpc
    const { at } = await mounted(["/rpc"]);

    // WHEN a sibling path sharing its first characters is requested
    const response = await at("/rpcx");

    // THEN it is a 404 rather than /rpc's: a mount point is a path segment,
    // not a string prefix
    expect(response.status).toBe(404);
  });

  it("refuses to start when two answerers claim one mount point", async ({ mountedApp }) => {
    // GIVEN two answerers mounted on the same prefix, one spelled with a
    // trailing slash — the same mount point, not two
    const app = mountedApp(["/rpc", "/rpc/"]);

    // WHEN the application boots
    // THEN it never serves: which of the two answers would be a coin toss
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "http" }),
    );
  });
});
