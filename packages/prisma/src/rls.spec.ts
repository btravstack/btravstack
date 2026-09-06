import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { tenantScoped } from "./rls.js";

const pinned = (setting: string) => ({
  raw: "SELECT set_config(?, ?, true)",
  values: [setting, "t-1"],
});

describe("tenantScoped", () => {
  it("pins a statement through the client the extension was applied over", async ({ stub }) => {
    // GIVEN a client the extension has been applied over
    const client = stub.client("stub://orders");
    tenantScoped("t-1")(client);

    // WHEN one model operation runs
    await client.operation("Order", "findMany", Promise.resolve(["a"]));

    // THEN the pin rode a batch of the pre-extension client, and the hook ran once
    expect({ issued: client.issued(), operations: client.operations() }).toEqual({
      issued: [{ kind: "batch", statements: [pinned("app.tenant_id"), { op: "findMany" }] }],
      operations: 1,
    });
  });

  it("answers the operation's own result, not the batch", async ({ stub }) => {
    // GIVEN a batch resolving with the pin's result beside the operation's
    const client = stub.client("stub://orders");
    client.resolveBatchWith([1, "the-row"]);
    tenantScoped("t-1")(client);

    // WHEN one model operation runs
    const answer = await client.operation("Order", "findFirst", Promise.resolve("ignored"));

    // THEN the hook handed back the second element
    expect(answer).toBe("the-row");
  });

  it("honours a custom setting", async ({ stub }) => {
    // GIVEN a client pinned through a setting of the application's own choosing
    const client = stub.client("stub://orders");
    tenantScoped("t-1", { setting: "app.org" })(client);

    // WHEN one model operation runs
    await client.operation("Order", "findMany", Promise.resolve(["a"]));

    // THEN that setting is what `set_config` was given
    expect(client.issued()).toEqual([
      { kind: "batch", statements: [pinned("app.org"), { op: "findMany" }] },
    ]);
  });

  it("pins raw SQL too, which is what the top-level hook is for", async ({ stub }) => {
    // GIVEN a client the extension has been applied over
    const client = stub.client("stub://orders");
    tenantScoped("t-1")(client);

    // WHEN a raw statement runs, with no model
    await client.operation(undefined, "$queryRaw", Promise.resolve([{ n: 1 }]));

    // THEN it was pinned exactly as a model operation is
    expect(client.issued()).toEqual([
      { kind: "batch", statements: [pinned("app.tenant_id"), { op: "$queryRaw" }] },
    ]);
  });

  it("pins an interactive transaction once, then runs the callback on it", async ({ stub }) => {
    // GIVEN a client the extension has been applied over
    const client = stub.client("stub://orders");
    tenantScoped("t-1")(client);

    // WHEN the installed `$transaction` runs a callback
    const result = await client.transaction(() => Promise.resolve("callback-ran-on-tx"));

    // THEN the pin was issued on the transaction's own client, before the callback
    expect({ issued: client.issued(), result }).toEqual({
      issued: [{ kind: "interactive", pinned: pinned("app.tenant_id") }],
      result: "callback-ran-on-tx",
    });
  });

  it("refuses the array form rather than ship a batch that stopped being atomic", async ({
    stub,
  }) => {
    // GIVEN a client the extension has been applied over
    const client = stub.client("stub://orders");
    tenantScoped("t-1")(client);

    // WHEN the installed `$transaction` is handed an array
    const refused = client.transaction([Promise.resolve(1), Promise.resolve(2)]);

    // THEN it rejects, and nothing was issued
    await expect(refused).rejects.toThrow(
      "tenantScoped: $transaction([...]) is unsupported — use the callback form.",
    );
  });

  it("does not re-enter the hook for a statement inside its own transaction, whose tx predates it", async ({
    stub,
  }) => {
    // GIVEN a client the extension has been applied over
    const client = stub.client("stub://orders");
    tenantScoped("t-1")(client);

    // WHEN the callback runs a statement on the `tx` it was handed
    await client.transaction((tx: { $queryRaw: () => Promise<unknown> }) => tx.$queryRaw());

    // THEN the top-level hook never saw it
    expect(client.operations()).toBe(0);
  });
});
