import {
  tagPatterns,
  WORKFLOW_RESULT_ERROR_TAGS,
  WORKFLOW_START_ERROR_TAGS,
} from "@temporal-contract/client";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("the fulfillment saga", () => {
  it("fulfills an order: place, reserve, ship, in order", async ({ tenant, serve, fulfilling }) => {
    // GIVEN the same composition `main.ts` boots, under the time-skipping env
    const { client } = await serve(fulfilling.module);

    // WHEN the workflow is driven to completion
    // THEN the order came back through a real Workflow Task, three real
    // Activity Tasks, and the use case and services behind them
    await expect(
      client.executeWorkflow("fulfillOrder", {
        workflowId: "wf-fulfill-1",
        args: { tenantId: tenant, orderId: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 },
      }),
    ).toBeOkWith({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 });

    // AND the journey ran in the declared order, each step a log line whose
    // order id is a field rather than a word — the trace id every line also
    // carries is the runtime's business, not this assertion's
    expect(
      fulfilling.lines().map((line) => ({ message: line.message, ...line.attributes })),
    ).toEqual([
      {
        message: "placing an order",
        tenantId: tenant,
        orderId: "0199a1e0-0000-7000-8000-000000000001",
        quantity: 2,
      },
      { message: "reserved stock", orderId: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 },
      { message: "arranged shipping", orderId: "0199a1e0-0000-7000-8000-000000000001" },
    ]);

    // AND the placement is durably there
    await expect(
      fulfilling.services().repository.find(tenant, "0199a1e0-0000-7000-8000-000000000001"),
    ).toBeOkWith(
      expect.objectContaining({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 }),
    );
  });

  it("compensates a stock refusal: the placement is walked back", async ({
    tenant,
    serve,
    outOfStock,
  }) => {
    // GIVEN stock that answers a permanent no
    const { client } = await serve(outOfStock.module);

    // WHEN the workflow runs
    const outcome = await client
      .executeWorkflow("fulfillOrder", {
        workflowId: "wf-oos-1",
        args: { tenantId: tenant, orderId: "0199a1e0-0000-7000-8000-000000000002", quantity: 5 },
      })
      .match({
        ok: () => "WRONGLY FULFILLED",
        // THEN the client can branch on the refusal by name — the saga's
        // answer is a typed contract error, not a broken execution
        errCases: (matcher) =>
          matcher
            .with({ errorName: "OutOfStock" }, (error) => `out-of-stock:${error.data.id}`)
            .with({ errorName: "InvalidQuantity" }, () => "WRONG ERROR")
            .with({ errorName: "InvalidOrderId" }, () => "WRONG ERROR")
            .with({ errorName: "OrderAlreadyPlaced" }, () => "WRONG ERROR")
            .with({ errorName: "ShippingUnavailable" }, () => "WRONG ERROR")
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: () => "DEFECT",
      });
    expect(outcome).toBe("out-of-stock:0199a1e0-0000-7000-8000-000000000002");

    // AND the placement the saga made before the refusal is gone — the
    // compensation ran, and the database agrees with the answer
    await expect(
      outOfStock.services().repository.find(tenant, "0199a1e0-0000-7000-8000-000000000002"),
    ).toBeErrTagged("OrderNotFound", {
      id: "0199a1e0-0000-7000-8000-000000000002",
    });
  });

  it("compensates a shipping refusal in reverse order: release, then cancel", async ({
    tenant,
    serve,
    noShipping,
  }) => {
    // GIVEN shipping that answers a permanent no, and stock that records what
    // the saga asks of it
    const { client } = await serve(noShipping.module);

    // WHEN the workflow runs
    const outcome = await client
      .executeWorkflow("fulfillOrder", {
        workflowId: "wf-ship-1",
        args: { tenantId: tenant, orderId: "0199a1e0-0000-7000-8000-000000000003", quantity: 1 },
      })
      .match({
        ok: () => "WRONGLY FULFILLED",
        // THEN the refusal reaches the client typed, after the compensation —
        // any other failure here is a different bug, and this fold names it
        errCases: (matcher) =>
          matcher
            .with({ errorName: "ShippingUnavailable" }, (error) => `no-shipping:${error.data.id}`)
            .with({ errorName: "InvalidQuantity" }, () => "WRONG ERROR")
            .with({ errorName: "InvalidOrderId" }, () => "WRONG ERROR")
            .with({ errorName: "OrderAlreadyPlaced" }, () => "WRONG ERROR")
            .with({ errorName: "OutOfStock" }, () => "WRONG ERROR")
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: () => "DEFECT",
      });
    expect(outcome).toBe("no-shipping:0199a1e0-0000-7000-8000-000000000003");

    // THEN the reservation was released — the walk-back reached the earlier
    // step, not just the placement
    expect(noShipping.released()).toEqual(["0199a1e0-0000-7000-8000-000000000003"]);

    // AND the placement is gone too
    await expect(
      noShipping.services().repository.find(tenant, "0199a1e0-0000-7000-8000-000000000003"),
    ).toBeErrTagged("OrderNotFound", {
      id: "0199a1e0-0000-7000-8000-000000000003",
    });
  });

  it("hands the client the OrderAlreadyPlaced the API answers CONFLICT for, as a typed contract error", async ({
    tenant,
    serve,
    fulfilling,
  }) => {
    // GIVEN an order already fulfilled by a first execution
    const { client } = await serve(fulfilling.module);

    // WHEN a second execution asks for the same order id — chained, so the
    // first execution's result is consumed and a failure there cannot be
    // mistaken for the duplicate
    const outcome = await client
      .executeWorkflow("fulfillOrder", {
        workflowId: "wf-dup-1",
        args: { tenantId: tenant, orderId: "0199a1e0-0000-7000-8000-000000000004", quantity: 2 },
      })
      .flatMap(() =>
        client.executeWorkflow("fulfillOrder", {
          workflowId: "wf-dup-2",
          args: { tenantId: tenant, orderId: "0199a1e0-0000-7000-8000-000000000004", quantity: 2 },
        }),
      )
      .match({
        ok: () => "WRONGLY PLACED",
        // THEN the identical `Err` the oRPC runtime turns into an inferable
        // CONFLICT is here a **branchable value at the client**, rehydrated by
        // name with its payload intact.
        errCases: (matcher) =>
          matcher
            .with({ errorName: "OrderAlreadyPlaced" }, (error) => `conflict:${error.data.id}`)
            .with({ errorName: "InvalidQuantity" }, () => "WRONG ERROR")
            .with({ errorName: "InvalidOrderId" }, () => "WRONG ERROR")
            .with({ errorName: "OutOfStock" }, () => "WRONG ERROR")
            .with({ errorName: "ShippingUnavailable" }, () => "WRONG ERROR")
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: () => "DEFECT",
      });

    expect(outcome).toBe("conflict:0199a1e0-0000-7000-8000-000000000004");
  });
});

describe("the billing saga", () => {
  it("polls one task queue for both workflows", async ({ tenant, serve, fulfilling }) => {
    // GIVEN a worker whose activities were composed from a fulfillment slice
    // and a billing slice, on the one queue this deployment owns
    const { client } = await serve(fulfilling.module);

    // WHEN the workflow the SECOND slice owns is executed
    const charged = client.executeWorkflow("chargeOrder", {
      workflowId: "wf-charge-1",
      args: { tenantId: tenant, orderId: "0199a1e0-0000-7000-8000-00000000a001", amount: 42 },
    });

    // THEN its own slice answered, so every piece was mounted under its key
    await expect(charged).toBeOkWith({
      authorizationId: "auth-0199a1e0-0000-7000-8000-00000000a001",
    });
  });
});
